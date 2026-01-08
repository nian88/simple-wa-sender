class MessageQueue {
  constructor({
    minDelayMs = 3000,
    maxDelayMs = 6000,
    burstLimit = 10,
    burstCooldownMs = 45000,
    dedupTtlMs = 3 * 60 * 1000,
  } = {}) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.burstLimit = burstLimit;
    this.burstCooldownMs = burstCooldownMs;
    this.dedupTtlMs = dedupTtlMs;

    this.queue = [];
    this.running = false;

    this.sentInBurst = 0;
    this.dedup = new Map(); // key -> expiresAt
  }

  _now() {
    return Date.now();
  }

  _randDelay() {
    const min = this.minDelayMs;
    const max = this.maxDelayMs;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  _gcDedup() {
    const now = this._now();
    for (const [k, exp] of this.dedup.entries()) {
      if (exp <= now) this.dedup.delete(k);
    }
  }

  enqueue(task, { dedupKey } = {}) {
    this._gcDedup();

    if (dedupKey) {
      const now = this._now();
      const exists = this.dedup.get(dedupKey);
      if (exists && exists > now) {
        return { accepted: false, reason: "duplicate" };
      }
      this.dedup.set(dedupKey, now + this.dedupTtlMs);
    }

    this.queue.push(task);
    this._run().catch(() => {});
    return { accepted: true };
  }

  size() {
    return this.queue.length;
  }

  async _sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async _run() {
    if (this.running) return;
    this.running = true;

    try {
      while (this.queue.length) {
        const task = this.queue.shift();

        // burst cooldown
        if (this.sentInBurst >= this.burstLimit) {
          await this._sleep(this.burstCooldownMs);
          this.sentInBurst = 0;
        }

        await task(); // harus throw kalau gagal biar bisa dicatat caller
        this.sentInBurst++;

        await this._sleep(this._randDelay());
      }
    } finally {
      this.running = false;
    }
  }
}

module.exports = { MessageQueue };