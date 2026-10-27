import { createInterface } from "node:readline/promises";

// Numbered menu. Returns the chosen option's value, or null if the user quits.
// With onRefresh, "r<N>" or "r <name>" passes that option's value to it and redraws the options it returns.
export async function pickOption({ title, options, input, output, onRefresh }) {
  const render = () => {
    const width = Math.max(...options.map((option) => option.name.length));
    output.write(`${title}\n`);
    options.forEach((option, index) => {
      output.write(`  ${index + 1}) ${option.name.padEnd(width)}  ${option.label}\n`);
    });
  };
  render();

  const rl = createInterface({ input, output });
  const closed = new Promise((resolve) => rl.once("close", () => resolve(null)));
  rl.once("SIGINT", () => rl.close());

  try {
    for (;;) {
      const hint = onRefresh ? ", r<N> refresh" : "";
      const prompt = `Choose [1-${options.length}, name${hint}, q to quit]: `;
      const reply = await Promise.race([rl.question(prompt).catch(() => null), closed]);
      const answer = reply?.trim();
      if (!answer || answer === "q") return null;

      const find = (key) => options[Number(key) - 1] ?? options.find((option) => option.name === key);
      const picked = find(answer);
      if (picked) return picked.value;

      const refresh = onRefresh && /^r\s*(\S+)$/.exec(answer);
      const target = refresh && find(refresh[1]);
      if (target) {
        options = await onRefresh(target.value);
        output.write("\n");
        render();
        continue;
      }
      output.write(`Unknown choice: ${answer}\n`);
    }
  } finally {
    rl.close();
  }
}
