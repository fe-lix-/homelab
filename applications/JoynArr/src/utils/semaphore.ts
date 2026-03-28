export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}
