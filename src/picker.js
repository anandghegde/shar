import { createInterface } from "node:readline/promises";

// Numbered menu. Returns the chosen option's value, or null if the user quits.
export async function pickOption({ title, options, input, output }) {
  const width = Math.max(...options.map((option) => option.name.length));
  output.write(`${title}\n`);
  options.forEach((option, index) => {
    output.write(`  ${index + 1}) ${option.name.padEnd(width)}  ${option.label}\n`);
  });

  const rl = createInterface({ input, output });
  const closed = new Promise((resolve) => rl.once("close", () => resolve(null)));
  rl.once("SIGINT", () => rl.close());

  try {
    for (;;) {
      const prompt = `Choose [1-${options.length}, name, q to quit]: `;
      const reply = await Promise.race([rl.question(prompt).catch(() => null), closed]);
      const answer = reply?.trim();
      if (!answer || answer === "q") return null;

      const picked = options[Number(answer) - 1] ?? options.find((option) => option.name === answer);
      if (picked) return picked.value;
      output.write(`Unknown choice: ${answer}\n`);
    }
  } finally {
    rl.close();
  }
}
