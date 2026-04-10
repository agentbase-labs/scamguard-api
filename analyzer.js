import axios from 'axios';
import NodeCache from 'node-cache';

// Cache for 5 minutes
const cache = new NodeCache({ stdTTL: 300 });

// ==================== CHAIN DETECTION ====================

/**
 * Detect blockchain type from address format
 */
function detectChain(address) {
  // Ethereum/BSC: 0x + 40 hex chars
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return 'evm';
  }
  
  // Solana: base58, typically 32-44 chars, no 0x prefix
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return 'solana';
  }
  
  return 'unknown';
}

// ==================== API INTEGRATIONS ====================

/**
 * Fetch token data from Dexscreener
 */
async function fetchDexscreener(address, chain = 'evm') {
  try {
    const cached = cache.get(`dex_${address}`);
    if (cached) return cached;

    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { timeout: 10000 }
    );

    const data = response.data;
    if (!data.pairs || data.pairs.length === 0) {
      return null;
    }

    // Get the pair with highest liquidity
    const topPair = data.pairs.sort((a, b) => 
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    const result = {
      name: topPair.baseToken?.name || 'Unknown',
      symbol: topPair.baseToken?.symbol || '???',
      priceUsd: parseFloat(topPair.priceUsd || 0),
      liquidity: parseFloat(topPair.liquidity?.usd || 0),
      volume24h: parseFloat(topPair.volume?.h24 || 0),
      priceChange24h: parseFloat(topPair.priceChange?.h24 || 0),
      marketCap: parseFloat(topPair.fdv || 0),
      pairAddress: topPair.pairAddress
    };

    cache.set(`dex_${address}`, result);
    return result;
  } catch (error) {
    console.error(`Dexscreener error for ${address}:`, error.message);
    return null;
  }
}

/**
 * Fetch RugCheck safety score (supports both EVM and Solana)
 */
async function fetchRugCheck(address, chain = 'evm') {
  try {
    const cached = cache.get(`rug_${address}`);
    if (cached) return cached;

    const response = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${address}/report`,
      { timeout: 10000 }
    );

    const data = response.data;
    const result = {
      score: data.score || 0,
      risks: data.risks || [],
      isScam: data.risks?.some(r => r.level === 'danger') || false
    };

    cache.set(`rug_${address}`, result);
    return result;
  } catch (error) {
    console.error(`RugCheck error for ${address}:`, error.message);
    return { score: 50, risks: [], isScam: false }; // neutral default
  }
}

/**
 * Check honeypot status (EVM only - Solana uses RugCheck)
 */
async function checkHoneypot(address, chain = 'evm') {
  // Honeypot.is only supports EVM chains
  if (chain === 'solana') {
    return { isHoneypot: false, buyTax: 0, sellTax: 0, transferTax: 0 };
  }

  try {
    const cached = cache.get(`honey_${address}`);
    if (cached) return cached;

    const response = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${address}`,
      { timeout: 10000 }
    );

    const data = response.data;
    const result = {
      isHoneypot: data.honeypotResult?.isHoneypot || false,
      buyTax: parseFloat(data.simulationResult?.buyTax || 0),
      sellTax: parseFloat(data.simulationResult?.sellTax || 0),
      transferTax: parseFloat(data.simulationResult?.transferTax || 0)
    };

    cache.set(`honey_${address}`, result);
    return result;
  } catch (error) {
    console.error(`Honeypot check error for ${address}:`, error.message);
    return { isHoneypot: false, buyTax: 0, sellTax: 0, transferTax: 0 };
  }
}

/**
 * Fetch contract verification and holder count from Etherscan (EVM only)
 */
async function fetchEtherscan(address, chain = 'evm') {
  // Etherscan only for EVM chains
  if (chain === 'solana') {
    return { verified: false, holderCount: 0 };
  }

  try {
    const apiKey = process.env.ETHERSCAN_API_KEY;
    if (!apiKey) return { verified: false, holderCount: 0 };

    const cached = cache.get(`eth_${address}`);
    if (cached) return cached;

    // Check contract verification
    const verifyRes = await axios.get(
      `https://api.etherscan.io/api?module=contract&action=getabi&address=${address}&apikey=${apiKey}`,
      { timeout: 10000 }
    );

    const verified = verifyRes.data.status === '1';

    // Note: Holder count requires premium API or alternative methods
    // For now, we'll estimate based on other signals
    const result = {
      verified,
      holderCount: 0 // Would need premium API or different source
    };

    cache.set(`eth_${address}`, result);
    return result;
  } catch (error) {
    console.error(`Etherscan error for ${address}:`, error.message);
    return { verified: false, holderCount: 0 };
  }
}

/**
 * Fetch Solana token holder info from Birdeye API
 */
async function fetchBirdeye(address) {
  try {
    const apiKey = process.env.BIRDEYE_API_KEY;
    const cached = cache.get(`birdeye_${address}`);
    if (cached) return cached;

    if (!apiKey) {
      console.log('Birdeye API key not set, skipping holder count');
      return { holderCount: 0, verified: false };
    }

    const response = await axios.get(
      `https://public-api.birdeye.so/defi/token_overview?address=${address}`,
      { 
        headers: { 'X-API-KEY': apiKey },
        timeout: 10000 
      }
    );

    const data = response.data.data;
    const result = {
      holderCount: data?.holder || 0,
      verified: data?.verified || false
    };

    cache.set(`birdeye_${address}`, result);
    return result;
  } catch (error) {
    console.error(`Birdeye error for ${address}:`, error.message);
    return { holderCount: 0, verified: false };
  }
}

// ==================== SCORING ALGORITHM ====================

/**
 * Calculate weighted score (0-100) based on multiple factors
 */
function calculateScore(data) {
  const {
    liquidity,
    volume24h,
    safetyScore,
    holderCount,
    priceChange24h,
    buyTax,
    sellTax,
    verified,
    isHoneypot,
    isScam
  } = data;

  // Red flags = instant rejection
  if (isHoneypot || isScam) {
    return 0;
  }

  let score = 0;

  // 1. Liquidity (25%)
  if (liquidity >= 100000) score += 25;
  else if (liquidity >= 50000) score += 20;
  else if (liquidity >= 10000) score += 15;
  else if (liquidity >= 5000) score += 10;
  else if (liquidity >= 1000) score += 5;

  // 2. Volume (20%)
  if (volume24h >= 100000) score += 20;
  else if (volume24h >= 50000) score += 16;
  else if (volume24h >= 10000) score += 12;
  else if (volume24h >= 5000) score += 8;
  else if (volume24h >= 1000) score += 4;

  // 3. Safety Score (20%)
  score += (safetyScore / 100) * 20;

  // 4. Holder Count (10%)
  if (holderCount >= 10000) score += 10;
  else if (holderCount >= 5000) score += 8;
  else if (holderCount >= 1000) score += 6;
  else if (holderCount >= 100) score += 4;
  else if (holderCount >= 10) score += 2;

  // 5. Price Momentum (10%)
  if (priceChange24h > 20) score += 10;
  else if (priceChange24h > 10) score += 8;
  else if (priceChange24h > 5) score += 6;
  else if (priceChange24h > 0) score += 4;
  else if (priceChange24h > -5) score += 2;

  // 6. Taxes (10%)
  const totalTax = buyTax + sellTax;
  if (totalTax <= 5) score += 10;
  else if (totalTax <= 10) score += 7;
  else if (totalTax <= 15) score += 3;
  else score += 0; // High tax penalty

  // 7. Contract Verification (5%)
  if (verified) score += 5;

  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Determine risk level
 */
function getRiskLevel(score, data) {
  if (data.isHoneypot || data.isScam) return 'CRITICAL';
  if (score >= 75) return 'LOW';
  if (score >= 50) return 'MEDIUM';
  return 'HIGH';
}

/**
 * Generate recommendation
 */
function getRecommendation(score, riskLevel) {
  if (riskLevel === 'CRITICAL') return 'AVOID';
  if (score >= 75) return 'STRONG BUY';
  if (score >= 60) return 'MODERATE BUY';
  if (score >= 40) return 'HOLD';
  return 'AVOID';
}

/**
 * Detect red flags
 */
function getRedFlags(data) {
  const flags = [];
  
  if (data.isHoneypot) flags.push('⚠️ HONEYPOT DETECTED');
  if (data.isScam) flags.push('🚫 SCAM RISK');
  if (data.liquidity < 5000) flags.push('💧 Very Low Liquidity');
  if (data.buyTax + data.sellTax > 15) flags.push('💸 High Taxes (>15%)');
  if (!data.verified) flags.push('❓ Unverified Contract');
  if (data.volume24h < 1000) flags.push('📉 Low Volume');

  return flags;
}

// ==================== MAIN ANALYZER ====================

/**
 * Analyze multiple tokens
 */
export async function analyzeTokens(addresses) {
  const results = await Promise.all(
    addresses.map(async (address) => {
      try {
        // Detect chain type
        const chain = detectChain(address);
        
        console.log(`Analyzing ${address} (${chain})...`);

        if (chain === 'unknown') {
          return {
            address,
            error: 'Unknown address format',
            score: 0,
            riskLevel: 'UNKNOWN',
            recommendation: 'SKIP',
            chain: 'unknown'
          };
        }

        // Fetch data from all sources in parallel (chain-aware)
        let dexData, rugData, honeyData, chainData;

        if (chain === 'solana') {
          [dexData, rugData, chainData] = await Promise.all([
            fetchDexscreener(address, chain),
            fetchRugCheck(address, chain),
            fetchBirdeye(address)
          ]);
          honeyData = { isHoneypot: false, buyTax: 0, sellTax: 0, transferTax: 0 };
        } else {
          [dexData, rugData, honeyData, chainData] = await Promise.all([
            fetchDexscreener(address, chain),
            fetchRugCheck(address, chain),
            checkHoneypot(address, chain),
            fetchEtherscan(address, chain)
          ]);
        }

        if (!dexData) {
          return {
            address,
            error: 'Token not found on DEX',
            score: 0,
            riskLevel: 'UNKNOWN',
            recommendation: 'SKIP',
            chain
          };
        }

        // Combine all data
        const combinedData = {
          liquidity: dexData.liquidity,
          volume24h: dexData.volume24h,
          safetyScore: rugData.score,
          holderCount: chainData.holderCount,
          priceChange24h: dexData.priceChange24h,
          buyTax: honeyData.buyTax,
          sellTax: honeyData.sellTax,
          verified: chainData.verified,
          isHoneypot: honeyData.isHoneypot,
          isScam: rugData.isScam
        };

        // Calculate score
        const score = calculateScore(combinedData);
        const riskLevel = getRiskLevel(score, combinedData);
        const recommendation = getRecommendation(score, riskLevel);
        const redFlags = getRedFlags(combinedData);

        return {
          address,
          name: dexData.name,
          symbol: dexData.symbol,
          score,
          riskLevel,
          recommendation,
          liquidity: dexData.liquidity,
          volume24h: dexData.volume24h,
          marketCap: dexData.marketCap,
          priceUsd: dexData.priceUsd,
          priceChange24h: dexData.priceChange24h,
          buyTax: honeyData.buyTax,
          sellTax: honeyData.sellTax,
          verified: chainData.verified,
          safetyScore: rugData.score,
          redFlags,
          pairAddress: dexData.pairAddress,
          chain
        };

      } catch (error) {
        console.error(`Error analyzing ${address}:`, error.message);
        return {
          address,
          error: error.message,
          score: 0,
          riskLevel: 'ERROR',
          recommendation: 'SKIP'
        };
      }
    })
  );

  // Sort by score (highest first)
  return results.sort((a, b) => b.score - a.score);
}