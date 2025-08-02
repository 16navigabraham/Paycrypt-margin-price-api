const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
app.use(cors({
  origin: [
    'https://paycryptv1.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173'
  ]
}));

// Your margin in Naira
const MARGIN_NGN = 10;

// Global cache - stores for 3 minutes
let priceCache = {};
let lastUpdate = 0;
const CACHE_DURATION = 3 * 60 * 1000; // 3 minutes

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'CoinGecko-compatible API running!',
    margin: `+${MARGIN_NGN} NGN`,
    cache_age: Math.floor((Date.now() - lastUpdate) / 1000),
    cached_tokens: Object.keys(priceCache)
  });
});

// CoinGecko-compatible endpoint - EXACT same format
app.get('/api/v3/simple/price', async (req, res) => {
  try {
    const { ids, vs_currencies } = req.query;
    
    if (!ids) {
      return res.status(400).json({ error: 'Missing ids parameter' });
    }
    
    const now = Date.now();
    const cacheAge = now - lastUpdate;
    
    // Return cached data if fresh (within 3 minutes)
    if (priceCache && Object.keys(priceCache).length > 0 && cacheAge < CACHE_DURATION) {
      console.log(`💾 Serving cached data (${Math.floor(cacheAge/1000)}s old)`);
      
      // Filter for requested tokens only
      const requestedTokens = ids.split(',').map(id => id.trim());
      const filteredResult = {};
      
      requestedTokens.forEach(tokenId => {
        if (priceCache[tokenId]) {
          filteredResult[tokenId] = priceCache[tokenId];
        }
      });
      
      if (Object.keys(filteredResult).length > 0) {
        return res.json(filteredResult);
      }
    }
    
    console.log(`🔄 Fetching fresh data for: ${ids}`);
    
    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Fetch from real CoinGecko
    const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs_currencies}`;
    
    const response = await axios.get(coinGeckoUrl, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PayCrypt/1.0)',
        'Accept': 'application/json'
      }
    });
    
    const originalData = response.data;
    
    if (!originalData || Object.keys(originalData).length === 0) {
      // Return stale cache if no fresh data
      if (Object.keys(priceCache).length > 0) {
        console.log('⚠️ No fresh data, returning stale cache');
        return res.json(priceCache);
      }
      return res.status(503).json({ error: 'No data available' });
    }
    
    // Apply margin to NGN prices - keep EXACT CoinGecko format
    const modifiedData = {};
    
    Object.entries(originalData).forEach(([tokenId, prices]) => {
      modifiedData[tokenId] = {
        ...prices, // Keep all original fields (usd, etc.)
        ngn: prices.ngn ? prices.ngn + MARGIN_NGN : prices.ngn // Add margin only to NGN
      };
    });
    
    // Update cache
    priceCache = { ...priceCache, ...modifiedData };
    lastUpdate = now;
    
    console.log('✅ Fresh data fetched and cached');
    console.log('💰 NGN prices with margin:', 
      Object.fromEntries(Object.entries(modifiedData).map(([token, prices]) => [token, prices.ngn]))
    );
    
    // Return in EXACT CoinGecko format
    res.json(modifiedData);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    
    // Return cached data if available (even if stale)
    if (Object.keys(priceCache).length > 0) {
      console.log('🆘 Error occurred, serving any available cache');
      const { ids } = req.query;
      if (ids) {
        const requestedTokens = ids.split(',').map(id => id.trim());
        const emergencyResult = {};
        
        requestedTokens.forEach(tokenId => {
          if (priceCache[tokenId]) {
            emergencyResult[tokenId] = priceCache[tokenId];
          }
        });
        
        if (Object.keys(emergencyResult).length > 0) {
          return res.json(emergencyResult);
        }
      }
      
      return res.json(priceCache);
    }
    
    // Final fallback
    res.status(500).json({
      error: 'Failed to fetch prices',
      message: 'Please try again in a few minutes'
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'PayCrypt Price API',
    description: 'CoinGecko-compatible API with NGN margin',
    margin: `+${MARGIN_NGN} NGN`,
    usage: '/api/v3/simple/price?ids=tether,ethereum&vs_currencies=ngn,usd'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 CoinGecko-compatible API running on port ${PORT}`);
  console.log(`💰 Adding ${MARGIN_NGN} NGN margin to all prices`);
  console.log(`💾 Cache duration: ${CACHE_DURATION/1000/60} minutes`);
});

module.exports = app;