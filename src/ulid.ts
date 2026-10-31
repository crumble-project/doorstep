const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom = new Uint8Array(10);

const encode = (value: bigint, length: number) => {
  let out = "";

  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }

  return out;
};

const toBigInt = (bytes: Uint8Array) =>
  bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

// Monotonic: an ID never sorts before an earlier one, even if the clock or `now` goes back.
export function ulid(now: Date): string {
  const time = now.getTime();

  if (time > lastTime) {
    lastTime = time;
    lastRandom = crypto.getRandomValues(new Uint8Array(10));
  } else {
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      lastRandom[i] = ((lastRandom[i] ?? 0) + 1) & 0xff;

      if (lastRandom[i] !== 0) break;
    }
  }

  return encode(BigInt(lastTime), 10) + encode(toBigInt(lastRandom), 16);
}
