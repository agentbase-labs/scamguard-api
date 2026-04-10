import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { analyzeTokens } from './analyzer.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*'
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main analysis endpoint
app.post('/api/analyze', async (req, res) => {
  try {
    const { addresses } = req.body;

    // Validation
    if (!addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ 
        error: 'Invalid input. Expected array of addresses.' 
      });
    }

    if (addresses.length === 0 || addresses.length > 50) {
      return res.status(400).json({ 
        error: 'Please provide between 1 and 50 contract addresses.' 
      });
    }

    // Validate address format (basic check)
    const validAddresses = addresses.filter(addr => 
      typeof addr === 'string' && 
      /^0x[a-fA-F0-9]{40}$/.test(addr.trim())
    );

    if (validAddresses.length === 0) {
      return res.status(400).json({ 
        error: 'No valid Ethereum/BSC addresses found.' 
      });
    }

    console.log(`Analyzing ${validAddresses.length} tokens...`);

    // Analyze tokens
    const results = await analyzeTokens(validAddresses);

    res.json({
      success: true,
      analyzed: results.length,
      results: results
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ 
      error: 'Internal server error during analysis',
      message: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Crypto Analyzer API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});
