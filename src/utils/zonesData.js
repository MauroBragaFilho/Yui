import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZONES_PATH = path.join(__dirname, '../data/zones.json');

export const zones = JSON.parse(fs.readFileSync(ZONES_PATH, 'utf8'));
export default zones;
