import { SeedRandomNumberGenerator } from '../../../utils/rng.js';
import { getSeedValue, getFutureResetDate } from '../../../utils/gtaSeed.js';
import { swapInt, systemRound } from '../../../utils/gtaMath.js';
import zones from '../../../utils/zonesData.js';
import { logger } from '../../../utils/logger.js';

function getRandomPrice(rng, maxRange) {
  let value = rng.getRandomIntRanged(0n, BigInt(maxRange) + 1n);
  const remainder = Number(value % 100n);
  value = remainder < 50 ? value - BigInt(remainder) : value + BigInt(100 - remainder);
  if (value > BigInt(maxRange)) return BigInt(maxRange);
  return value;
}

function getProductValues(rng, product, premiumProduct) {
  let value;
  let raw;

  switch (product) {
    case 2: {
      raw = 19000n + getRandomPrice(rng, 21000 - 19000);
      value = systemRound(Number(raw) / 1.0);
      break;
    }
    case 3: {
      raw = 16500n + getRandomPrice(rng, 18500 - 16500);
      value = systemRound(Number(raw) / 2.0);
      break;
    }
    case 4: {
      raw = 14000n + getRandomPrice(rng, 16000 - 14000);
      value = systemRound(Number(raw) / 10.0);
      break;
    }
    case 7: {
      raw = 13850n + getRandomPrice(rng, 15850 - 13850);
      value = Math.round(Number(raw) / 10.0);
      break;
    }
    default:
      value = 0;
  }

  if (product === premiumProduct) {
    value = systemRound(value * 2.0);
  }

  return value;
}

function getPremiumProduct(rng) {
  const w1 = 1.5;
  const w2 = 2.0;
  const w3 = 3.0;
  const w4 = 3.5;
  const total = w1 + w2 + w3 + w4;

  const roll = rng.getRandomFloatRanged(0.0, total);

  const t1 = total - w1;
  const t2 = t1 - w2;
  const t3 = t2 - w3;

  if (roll > t1) return 2;
  if (roll > t2) return 3;
  if (roll > t3) return 4;
  return 7;
}

const PRODUCT_NAMES = { 2: 'Cocaína', 3: 'Metanfetamina', 4: 'Maconha', 7: 'Ácido' };
const PRODUCT_MULTIPLIERS = { 2: 1, 3: 2, 4: 10, 7: 10 };

function populateStreetDealers(date) {
  let indices = Array.from({ length: 50 }, (_, i) => i);
  let rng = new SeedRandomNumberGenerator(getSeedValue(date));

  for (let i = 49; i >= 1; i--) {
    const j = Number(rng.getRandomIntRanged(0n, BigInt(i)));
    swapInt(indices, i, j);
  }

  const locations = [indices[0], indices[1], indices[2]];

  rng = new SeedRandomNumberGenerator(getSeedValue(date));

  const dealers = [];
  for (let i = 0; i < 3; i++) {
    const premium = getPremiumProduct(rng);
    const prices = {
      2: getProductValues(rng, 2, premium),
      3: getProductValues(rng, 3, premium),
      4: getProductValues(rng, 4, premium),
      7: getProductValues(rng, 7, premium),
    };
    dealers.push({ locationIndex: locations[i], premiumProduct: premium, prices });
  }

  return dealers;
}

/**
 * Calcula as localizações e preços dos Street Dealers.
 * @param {number} offsetDays 0 = hoje, N = daqui N dias (previsão futura)
 */
export async function fetchStreetDealers(offsetDays = 0) {
  try {
    const date = offsetDays === 0 ? new Date() : getFutureResetDate(offsetDays);
    const dealers = populateStreetDealers(date);

    let grandTotal = 0;
    const result = dealers.map((dealer) => {
      const { prices } = dealer;
      const total = 1 * prices[2] + 2 * prices[3] + 10 * prices[4] + 10 * prices[7];
      grandTotal += total;

      const products = Object.entries(prices).map(([code, price]) => ({
        name: PRODUCT_NAMES[code],
        unitPrice: price,
        totalPrice: price * PRODUCT_MULTIPLIERS[code],
        isPremium: Number(code) === dealer.premiumProduct,
      }));

      return {
        locationIndex: dealer.locationIndex + 1,
        locationName: zones.street_dealers[dealer.locationIndex] || 'Localização desconhecida',
        premiumProduct: PRODUCT_NAMES[dealer.premiumProduct],
        products,
        total,
      };
    });

    return { dealers: result, grandTotal, date: date.toISOString() };
  } catch (error) {
    logger.warn(`[GTAO] Falha ao calcular os Comerciantes: ${error.message}`);
    return null;
  }
}
