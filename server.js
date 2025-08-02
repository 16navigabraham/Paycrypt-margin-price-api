const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration for your Vercel frontend
const corsOptions = {
  origin: [
    'https://paycryptv1.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173', // For Vite dev server
    'http://127.0.0.1:3000'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));

// Your margin in Naira (change this to whatever you want)
const MARGIN_NGN = 10;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Margin API is running! 🚀',
    margin: `Adding ${MARGIN_NGN} NGN to all prices`
  });
});

// Main endpoint - exactly like CoinGecko but with your margin
app.get('/api/v3/simple/price', async (req, res) => {
  try {
    const { ids, vs_currencies } = req.query;
    
    console.log(`📊 Fetching prices for: ${ids}`);
    
    // Get original prices from CoinGecko
    const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs_currencies}`;
    const response = await axios.get(coinGeckoUrl, { timeout: 15000 });
    
    const originalData = response.data;
    const modifiedData = {};
    
    // Add your margin to NGN prices only
    Object.entries(originalData).forEach(([tokenId, prices]) => {
      modifiedData[tokenId] = {
        usd: prices.usd, // Keep USD price unchanged
        ngn: prices.ngn ? prices.ngn + MARGIN_NGN : prices.ngn // Add margin to NGN
      };
    });
    
    // Log the changes (you'll see this in Render logs)
    console.log('🏷️ Original NGN prices:', 
      Object.fromEntries(Object.entries(originalData).map(([token, prices]) => [token, prices.ngn]))
    );
    console.log('💰 Your NGN prices (+10):', 
      Object.fromEntries(Object.entries(modifiedData).map(([token, prices]) => [token, prices.ngn]))
    );
    
    // Send modified data to your frontend
    res.json(modifiedData);
    
  } catch (error) {
    console.error('❌ Error fetching prices:', error.message);
    
    // Send error response
    res.status(500).json({
      error: 'Failed to fetch prices',
      message: error.message
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Margin API is running on port ${PORT}`);
  console.log(`💰 Adding ${MARGIN_NGN} NGN margin to all crypto prices`);
  console.log(`🌐 Visit /health to check if everything is working`);
});

module.exports = app;