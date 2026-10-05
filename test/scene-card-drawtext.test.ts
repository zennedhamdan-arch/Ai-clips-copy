import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { buildDrawTextFilter, buildSceneCardVf, drawTextFontFile, escapeDrawText } from "@/lib/ffmpeg";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

test("1. normal title: passed through unchanged, filter well-formed", () => {
  assert.equal(escapeDrawText("The Long Con"), "The Long Con");
  const filter = buildDrawTextFilter({ text: "The Long Con", color: "white", size: 96, x: "(w-text_w)/2", y: "h*0.30", fontFile: FONT });
  assert.equal(
    filter,
    `drawtext=fontfile=${FONT}:fontcolor=white:fontsize=96:x=(w-text_w)/2:y=h*0.30:text=The Long Con`,
  );
});

test("2. empty title: no drawtext filter is emitted (the old crash)", () => {
  assert.equal(escapeDrawText(""), "");
  assert.equal(escapeDrawText("   "), "");
  assert.equal(escapeDrawText(null), "");
  assert.equal(escapeDrawText(undefined), "");

  assert.equal(buildDrawTextFilter({ text: "", color: "white", size: 96, x: "0", y: "0" }), null);
  assert.equal(buildDrawTextFilter({ text: "  ", color: "white", size: 96, x: "0", y: "0" }), null);

  // Card with no title and no subtitle: only the watermark + fades remain,
  // and no empty `text=` option exists anywhere in the filter chain.
  const vf = buildSceneCardVf({ title: "", subtitle: "", fontFile: FONT, durationSec: 30 });
  assert.equal(vf.match(/drawtext=/g)?.length, 1, "only the watermark drawtext remains");
  assert.ok(vf.includes("CLIPFORGE DOCUMENTARY"));
  assert.ok(!/text=$/.test(vf), "no empty text= option");
  assert.ok(!/text=,/.test(vf), "no empty text= option");
});

test("3. special characters: ':', '%', apostrophe, brackets, newline are escaped", () => {
  const escaped = escapeDrawText("50%: it's [final]\nact");
  // % doubled for drawtext expansion; : ' [ ] backslash-escaped for the
  // filtergraph; the newline folded into a single space.
  assert.equal(escaped, "50%%\\: it\\'s \\[final\\] act");
  // No raw (un-doubled) percent remains — a bare % could start a %{...}
  // expansion and make FFmpeg fail.
  assert.ok(!/%/.test(escaped.replace(/%%/g, "")), "every percent must be doubled");
  assert.ok(!escaped.includes("\n"), "newlines must not reach the filter string");

  const filter = buildDrawTextFilter({ text: "50%: it's [final]\nact", color: "white", size: 96, x: "0", y: "0", fontFile: null });
  assert.ok(filter);
  assert.ok(filter.endsWith("text=50%%\\: it\\'s \\[final\\] act"), filter);

  // Backslashes are escaped first so they survive the filtergraph unescape.
  assert.equal(escapeDrawText("C:\\Users\\new"), String.raw`C\:\\Users\\new`);
});

test("4. missing subtitle: subtitle filter is skipped, title + watermark kept", () => {
  const vf = buildSceneCardVf({ title: "The Long Con", subtitle: undefined, fontFile: FONT, durationSec: 30 });
  assert.equal(vf.match(/drawtext=/g)?.length, 2, "title + watermark only");
  assert.ok(!vf.includes("fontsize=48"), "no subtitle drawtext at 48px");
  assert.ok(vf.includes("text=The Long Con"));
  assert.ok(vf.includes("CLIPFORGE DOCUMENTARY"));

  // Same when the subtitle is explicitly null.
  const vfNull = buildSceneCardVf({ title: "The Long Con", subtitle: null, fontFile: FONT, durationSec: 30 });
  assert.equal(vfNull.match(/drawtext=/g)?.length, 2);
});

test("5. missing font: fontfile omitted, text still valid", () => {
  const vf = buildSceneCardVf({ title: "The Long Con", subtitle: "Season 2", fontFile: null, durationSec: 30 });
  assert.ok(!vf.includes("fontfile="), "fontfile must not appear without a verified font");
  assert.equal(vf.match(/drawtext=/g)?.length, 3, "title + subtitle + watermark all render");
  assert.ok(vf.includes("text=The Long Con"));
  assert.ok(vf.includes("text=Season 2"));
  assert.ok(vf.includes("text=CLIPFORGE DOCUMENTARY"));
});

test("full card filter is deterministic (title + subtitle + watermark + fades)", () => {
  const vf = buildSceneCardVf({ title: "The Long Con", subtitle: "Season 2", fontFile: FONT, durationSec: 30 });
  const expected = [
    `drawtext=fontfile=${FONT}:fontcolor=white:fontsize=96:x=(w-text_w)/2:y=h*0.30:text=The Long Con`,
    `drawtext=fontfile=${FONT}:fontcolor=white@0.8:fontsize=48:x=(w-text_w)/2:y=h*0.30+170:text=Season 2`,
    `drawtext=fontfile=${FONT}:fontcolor=white@0.45:fontsize=34:x=w-360:y=h-170:text=CLIPFORGE DOCUMENTARY`,
    "fade=t=in:st=0:d=1.1",
    "fade=t=out:st=29.000:d=1.000",
  ].join(",");
  assert.equal(vf, expected);
});

test("truncation happens before escaping so escape sequences are never cut", () => {
  const long = "a".repeat(100);
  const escaped = escapeDrawText(long);
  assert.equal(escaped.length, 90);
  const percented = "%".repeat(100);
  const doubled = escapeDrawText(percented);
  // 90 chars truncated -> 45 doubled "%%" pairs: no dangling single % left.
  assert.equal(doubled.length, 180);
  assert.ok(!/%/.test(doubled.replace(/%%/g, "")), "truncation must not leave a dangling single %");
});

test("drawTextFontFile only ever returns a verified regular file", () => {
  const font = drawTextFontFile();
  if (font !== null) {
    assert.ok(statSync(font).isFile(), `font path must be a regular file: ${font}`);
  }
});
