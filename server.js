const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache prices for 2 minutes to avoid rate limiting
const cache = new NodeCache({ stdTTL: 120 });

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
  const cacheStats = cache.getStats();
  res.json({ 
    success: true, 
    message: 'Margin API is running! 🚀',
    margin: `Adding ${MARGIN_NGN} NGN to all prices`,
    cache: {
      keys: cache.keys().length,
      hits: cacheStats.hits,
      misses: cacheStats.misses
    }
  });
});

// Main endpoint - exactly like CoinGecko but with your margin
app.get('/api/v3/simple/price', async (req, res) => {
  try {
    const { ids, vs_currencies } = req.query;
    
    // Create cache key
    const cacheKey = `${ids}_${vs_currencies}`;
    
    // Check cache first
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      console.log(`💾 Cache HIT for: ${ids}`);
      return res.json(cachedData);
    }
    
    console.log(`📊 Cache MISS - Fetching fresh prices for: ${ids}`);
    
    // Get original prices from CoinGecko with delay to avoid rate limiting
    const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs_currencies}`;
    
    // Add delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const response = await axios.get(coinGeckoUrl, { 
      timeout: 15000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PayCrypt-Margin-API/1.0'
      }
    });
    
    const originalData = response.data;
    const modifiedData = {};
    
    // Add your margin to NGN prices only
    Object.entries(originalData).forEach(([tokenId, prices]) => {
      modifiedData[tokenId] = {
        usd: prices.usd, // Keep USD price unchanged
        ngn: prices.ngn ? prices.ngn + MARGIN_NGN : prices.ngn // Add margin to NGN
      };
    });
    
    // Cache the modified data
    cache.set(cacheKey, modifiedData);
    
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
    
    // If it's a rate limit error, try to serve stale cache data
    if (error.response?.status === 429) {
      const { ids, vs_currencies } = req.query;
      const cacheKey = `${ids}_${vs_currencies}`;
      const staleData = cache.get(cacheKey);
      
      if (staleData) {
        console.log('⚠️ Rate limited - serving stale cache data');
        return res.json({
          ...staleData,
          _warning: 'Using cached data due to rate limiting'
        });
      }
    }
    
    // Send error response
    res.status(500).json({
      error: 'Failed to fetch prices',
      message: error.response?.status === 429 ? 
        'Rate limited by CoinGecko. Please try again in a moment.' : 
        error.message
    });
  }
});

// Cache stats endpoint
app.get('/cache/stats', (req, res) => {
  const stats = cache.getStats();
  res.json({
    success: true,
    cache: {
      keys: cache.keys().length,
      hits: stats.hits,
      misses: stats.misses,
      hitRate: stats.hits / (stats.hits + stats.misses) || 0
    }
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Margin API is running on port ${PORT}`);
  console.log(`💰 Adding ${MARGIN_NGN} NGN margin to all crypto prices`);
  console.log(`💾 Caching enabled for 2 minutes to avoid rate limits`);
  console.log(`🌐 Visit /health to check if everything is working`);
});

module.exports = app;