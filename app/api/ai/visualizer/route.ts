import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";

export const dynamic = "force-dynamic";

/**
 * AI visual director. Given the song + a free-text vibe prompt, Claude either
 * picks and themes one of the built-in real-time templates, OR writes a brand
 * new GLSL fragment shader tailored to the mood. Everything stays code-driven
 * and real-time , we never generate a video file.
 */
const SYSTEM = `You are a creative coder + VJ who designs REAL-TIME, beat-reactive music
visuals (think Windows Media Player visualizers, Milkdrop, and Shadertoy art). You receive a
song (title, artist, BPM, musical key) and a free-text vibe prompt, plus a list of built-in
templates. Decide how to make the best animated "music video" for THIS song and prompt.

Two modes:
1) "template" , pick the built-in template whose style best fits, and theme it with params.
2) "shader" , write a NEW GLSL ES 1.00 fragment shader when the prompt calls for something the
   built-ins don't cover. Prefer this for specific imagery ("neon city rain", "lava lamp",
   "ocean at night", "matrix code").

When writing a shader, define ONLY:
  void mainImage(out vec4 fragColor, in vec2 fragCoord)
Do NOT include a precision line, uniforms, or main() , they are prepended for you. These
uniforms and helpers are available (use them so the visual REACTS to the music):
  vec2  iResolution   // pixels
  float iTime         // seconds (already speed-scaled)
  float iLevel        // 0..1 overall loudness
  float iLow, iMid, iHigh   // 0..1 band energies (bass / mids / treble)
  float iBeat         // 0..1 phase within the current beat
  float iBeatPulse    // 0..1, snaps to 1 ON each beat then eases down , great for flashes/zooms
  float iBar          // 0..1 phase within the 4-beat bar
  float iOnset        // 0..1 transient/kick detector
  float iHue          // 0..1 base hue derived from the song key
  float iIntensity    // user reactivity multiplier (~0..2)
  float iKeyColor     // vec3 rgb anchor color from the key , tint toward it
  float iChroma[12]   // 12 pitch-class energies , the live chord (0=C..11=B)
  sampler2D iSpectrum // helpers: fft(x) and wave(x), x in 0..1, return 0..1
  vec3 hsv2rgb(vec3)  // helper
Rules for shaders: must compile as GLSL ES 1.00 (WebGL1). Use mediump-safe math. No textures
other than iSpectrum. No #version, no arrays you declare yourself beyond small fixed loops
(loop bounds must be constant ints). Keep it self-contained and ~40 lines max. Make bass drive
scale/brightness, treble drive detail, and iBeatPulse/iOnset drive flashes or camera kicks.
Tint the palette toward iKeyColor or iHue so it matches the song's key.

params (always include): {
  "hue": 0-360 base color,
  "hueRange": 0-240 palette spread,
  "intensity": 0-2 reactivity,
  "speed": 0-2 motion,
  "complexity": 0-1 detail,
  "glow": 0-1 bloom,
  "palette": ["#rrggbb", ...]  // optional 2-4 colors matching the vibe
}

Match params to mood: chill/ambient → low speed+intensity, high glow, cool hues; hype/EDM →
high intensity+speed, saturated hues; dark → low lightness palette. Use the song key for hue
when the prompt has no strong color cue.

Respond with ONLY JSON:
{"mode":"template"|"shader","templateId":"<id, when mode=template>","fragment":"<glsl, when mode=shader>","name":"<short name when shader>","params":{...},"reasoning":"one fun sentence"}`;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const client = new Anthropic();

  let text = "{}";
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1600,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            prompt: body.prompt || "(no prompt , match the song's mood)",
            track: body.track, // {title, artist, bpm, keyName, camelot}
            arc: body.arc, // {energy, phase} when an arc set is running
            templates: body.templates, // [{id, name, blurb, kind}]
          }),
        },
      ],
    });
    text = msg.content[0]?.type === "text" ? msg.content[0].text : "{}";
    const directive = extractJson<Record<string, unknown>>(text);
    return NextResponse.json(directive);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "visual director failed", raw: text },
      { status: 502 }
    );
  }
}
