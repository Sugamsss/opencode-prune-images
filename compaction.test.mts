import { pruneImages } from "./index.ts";
import assert from "node:assert";

function makeSession(nImages: number) {
  const messages = [];
  for (let i = 0; i < nImages; i++) {
    const px = "A".repeat(1200);
    messages.push({
      role: "user",
      parts: [
        { type: "text", text: `captura ${i}` },
        { type: "media", mediaType: "image/png", data: `data:image/png;base64,${px}`, filename: `screenshot-${i}.png` },
      ],
    });
  }
  return messages;
}

function countImages(messages) {
  let n = 0;
  for (const m of messages) for (const p of m.parts) if (p.type === "media" && p.data) n++;
  return n;
}

const comp = { agent: "compaction", messages: makeSession(35) };
assert.equal(pruneImages(comp, 0, 0), 35, "compaction must prune all 35 images");
assert.equal(countImages(comp.messages), 0, "compaction must keep zero raw images");

const norm = { messages: makeSession(35) };
pruneImages(norm, 7, 16 * 1024 * 1024);
assert.equal(countImages(norm.messages), 7, "normal requests must keep 7 images");

assert.ok(
  String(norm.messages[0].parts[1].text).includes("[Pruned Image:"),
  "pruned images must leave a text card"
);

console.log("OK: compaction prunes 35/35, normal keeps 7, cards present");
