import { CustomEditor } from "@earendil-works/pi-coding-agent";

const ULTRACODE_MATCH = /ultracode/gi;
const RESET = "\x1b[0m";
const BLINK = "\x1b[5m";
const NO_BLINK = "\x1b[25m";
const ANIMATION_INTERVAL_MS = 80;

const RAINBOW_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [233, 137, 115],
  [228, 186, 103],
  [141, 192, 122],
  [102, 194, 179],
  [121, 157, 207],
  [157, 134, 195],
  [206, 130, 172],
];

export function containsUltracode(text: string): boolean {
  return /ultracode/i.test(text);
}

export function colorizeUltracodeMatch(text: string, frame: number): string {
  const cycle = frame % 20;
  const shinePosition = cycle < 10 ? cycle : -1;
  const blink = frame % 12 < 6 ? BLINK : "";

  return `${blink}${[...text]
    .map((char, index) => {
      const base = RAINBOW_COLORS[index % RAINBOW_COLORS.length]!;
      return `${foregroundColor(brighten(base, shineFactor(index, shinePosition)))}${char}`;
    })
    .join("")}${NO_BLINK}${RESET}`;
}

export function colorizeUltracodeText(text: string, frame: number): string {
  return text.replace(ULTRACODE_MATCH, (match) => colorizeUltracodeMatch(match, frame));
}

export class UltracodeEditor extends CustomEditor {
  #animationTimer?: ReturnType<typeof setInterval>;
  #frame = 0;

  override handleInput(data: string): void {
    super.handleInput(data);
    this.#syncAnimation();
  }

  override setText(text: string): void {
    super.setText(text);
    this.#syncAnimation();
  }

  override render(width: number): string[] {
    return super.render(width).map((line) => colorizeUltracodeText(line, this.#frame));
  }

  dispose(): void {
    this.#stopAnimation();
  }

  #syncAnimation(): void {
    if (containsUltracode(this.getText())) {
      this.#startAnimation();
      return;
    }

    this.#stopAnimation();
  }

  #startAnimation(): void {
    if (this.#animationTimer !== undefined) return;

    this.#animationTimer = setInterval(() => {
      this.#frame += 1;
      this.tui.requestRender();
    }, ANIMATION_INTERVAL_MS);
  }

  #stopAnimation(): void {
    if (this.#animationTimer === undefined) return;

    clearInterval(this.#animationTimer);
    this.#animationTimer = undefined;
  }
}

function foregroundColor(rgb: readonly [number, number, number]): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function brighten(
  rgb: readonly [number, number, number],
  factor: number,
): readonly [number, number, number] {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * factor),
    Math.round(rgb[1] + (255 - rgb[1]) * factor),
    Math.round(rgb[2] + (255 - rgb[2]) * factor),
  ];
}

function shineFactor(index: number, shinePosition: number): number {
  if (shinePosition < 0) return 0;

  const distance = Math.abs(index - shinePosition);
  if (distance === 0) return 0.7;
  if (distance === 1) return 0.35;
  return 0;
}
