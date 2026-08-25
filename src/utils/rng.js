/**
 * Gerador de números pseudo-aleatórios com seed, replicando o algoritmo
 * usado internamente pelo GTA Online para calcular rotações diárias
 * (Gun Van, Street Dealers, etc). Portado de ShinyWasabi/GTAO-Bot,
 * créditos originais a gir489returns pela engenharia reversa.
 *
 * Por ser 100% determinístico a partir de um "seed" derivado da data,
 * o mesmo cálculo pode ser feito para uma data passada, a atual, ou
 * uma data FUTURA — o que permite prever rotações de dias que ainda
 * não chegaram, sem precisar aguardar o reset ou consultar qualquer API.
 */
export class SeedRandomNumberGenerator {
  #maxInt = BigInt(0x7fffffff);
  #maxFloat = BigInt(0x7fffff);
  #mask = 2n ** 32n - 1n;
  #magicNumber = 1557985959n;

  constructor(seedParam) {
    const seed = BigInt(seedParam);
    const rolval = ((seed << 16n) & this.#mask) | ((seed >> 16n) & this.#mask);
    this.seed0 = seed || 1n;
    this.seed1 = seed ^ rolval;
  }

  #nextSeed() {
    const nextSeed = this.#magicNumber * this.seed0 + this.seed1;
    this.seed0 = nextSeed & BigInt(0xffffffff);
    this.seed1 = nextSeed >> 32n;
    return nextSeed;
  }

  getRandomIntRanged(min, max) {
    if (min === max) return min;
    if (min >= max) return 0n;
    const nextSeed = this.#nextSeed();
    return min + ((nextSeed & this.#maxInt) % (max - min + 1n));
  }

  getRandomFloatRanged(min, max) {
    if (min === max) return min;
    if (min >= max) return 0;
    const range = max - min;
    const nextSeed = this.#nextSeed();
    return min + range * (Number(nextSeed & this.#maxFloat) / Number(this.#maxFloat));
  }
}

export default SeedRandomNumberGenerator;
