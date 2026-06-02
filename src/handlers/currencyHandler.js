const fs = require('fs');
const path = require('path');
const axios = require('axios');

const cachePath = path.join(__dirname, '../data/currency_cache.json');

const nameMap = {
    'DOLAR': 'USD', 'DÓLAR': 'USD', 'US': 'USD', 'DOLAR AMERICANO': 'USD',
    'REAIS': 'BRL', 'REAL': 'BRL', 'BR': 'BRL',
    'EURO': 'EUR', 'EUROS': 'EUR', 
    'BITCOIN': 'BTC', 'ETHEREUM': 'ETH',
    'LIBRA': 'GBP', 'PESO': 'ARS', 'PESOS': 'ARS', 'IENE': 'JPY'
};

async function getCache() {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    let cache = null;
    if (fs.existsSync(cachePath)) {
        try {
            cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        } catch (e) {
            cache = null;
        }
    }
    
    if (cache && cache.date === todayStr && cache.rates) {
        return cache;
    }
    
    try {
        const response = await axios.get('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL,GBP-BRL,JPY-BRL,CAD-BRL,AUD-BRL,ARS-BRL,CLP-BRL,CNY-BRL,BTC-BRL,ETH-BRL', { timeout: 10000 });
        const rates = { BRL: 1.0 };
        const data = response.data;
        
        for (const key of Object.keys(data)) {
            const coin = key.replace('BRL', '');
            const bid = parseFloat(data[key].bid);
            if (!isNaN(bid)) {
                rates[coin] = bid;
            }
        }
        
        cache = {
            date: todayStr,
            rates: rates,
            dynamicRates: {}
        };
        
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
        return cache;
    } catch (error) {
        if (cache && cache.rates) {
            return cache;
        }
        throw error;
    }
}

async function convertCurrency(amount, from, to) {
    if (!amount || isNaN(amount)) amount = 1;
    from = String(from).toUpperCase().trim();
    to = String(to).toUpperCase().trim();
    
    if (nameMap[from]) from = nameMap[from];
    if (nameMap[to]) to = nameMap[to];
    
    let cache;
    try {
        cache = await getCache();
    } catch (e) {
        return { error: 'Não consegui carregar as cotações das moedas no momento.' };
    }
    
    if (cache.rates[from] !== undefined && cache.rates[to] !== undefined) {
        const rateFromBRL = cache.rates[from];
        const rateToBRL = cache.rates[to];
        const rate = rateFromBRL / rateToBRL;
        const converted = amount * rate;
        
        return {
            success: true,
            from: from,
            to: to,
            amount: amount,
            rate: rate,
            result: converted,
            name: `${from}/${to}`,
            lastUpdate: cache.date
        };
    }
    
    const directKey = `${from}-${to}`;
    const inverseKey = `${to}-${from}`;
    
    if (cache.dynamicRates[directKey] !== undefined) {
        const rateData = cache.dynamicRates[directKey];
        return {
            success: true,
            from: from,
            to: to,
            amount: amount,
            rate: rateData.rate,
            result: amount * rateData.rate,
            name: rateData.name,
            lastUpdate: rateData.lastUpdate
        };
    }
    
    if (cache.dynamicRates[inverseKey] !== undefined) {
        const rateData = cache.dynamicRates[inverseKey];
        const rate = 1 / rateData.rate;
        return {
            success: true,
            from: from,
            to: to,
            amount: amount,
            rate: rate,
            result: amount * rate,
            name: `${from}/${to} (Inverso de ${rateData.name})`,
            lastUpdate: rateData.lastUpdate
        };
    }
    
    try {
        const response = await axios.get(`https://economia.awesomeapi.com.br/json/last/${from}-${to}`, { timeout: 10000 });
        const pairKey = Object.keys(response.data)[0];
        if (!pairKey) return { error: `Câmbio de ${from} para ${to} não encontrado.` };
        
        const rateData = response.data[pairKey];
        const bid = parseFloat(rateData.bid);
        
        cache.dynamicRates[directKey] = {
            rate: bid,
            name: rateData.name,
            lastUpdate: rateData.create_date
        };
        
        try {
            fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
        } catch (e) {}
        
        return {
            success: true,
            from: from,
            to: to,
            amount: amount,
            rate: bid,
            result: amount * bid,
            name: rateData.name,
            lastUpdate: rateData.create_date
        };
    } catch (error) {
        try {
            const fallbackRes = await axios.get(`https://economia.awesomeapi.com.br/json/last/${to}-${from}`, { timeout: 10000 });
            const pairKey = Object.keys(fallbackRes.data)[0];
            if (!pairKey) return { error: `Câmbio de ${from} para ${to} não encontrado.` };
            
            const rateData = fallbackRes.data[pairKey];
            const bid = parseFloat(rateData.bid);
            const rate = 1 / bid;
            
            cache.dynamicRates[directKey] = {
                rate: rate,
                name: `${from}/${to} (Inverso de ${rateData.name})`,
                lastUpdate: rateData.create_date
            };
            
            try {
                fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
            } catch (e) {}
            
            return {
                success: true,
                from: from,
                to: to,
                amount: amount,
                rate: rate,
                result: amount * rate,
                name: `${from}/${to} (Inverso de ${rateData.name})`,
                lastUpdate: rateData.create_date
            };
        } catch (fallbackError) {
            return { error: `Não consegui a cotação oficial para ${from} -> ${to}. Confira se os códigos da moeda existem (Ex: USD, EUR, BTC, BRL).` };
        }
    }
}

module.exports = {
    convertCurrency
};
