export interface ToolMeta {
  slug: string;
  title: string;
  short: string;
  description: string;
  /** Long-tail search phrase the page is written for. */
  keyword: string;
  intro: string;
  /** Short how-to / explainer paragraphs under the tool. */
  notes: { h: string; p: string }[];
  faq: { q: string; a: string }[];
}

export const TOOLS: ToolMeta[] = [
  {
    slug: "tap-tempo",
    title: "Tap Tempo BPM Counter",
    short: "Tap the beat, get the BPM",
    description: "Free tap tempo tool: tap along to any song and get its BPM, plus half-time and double-time. Runs in your browser.",
    keyword: "tap tempo",
    intro: "Tap any key, click the pad or press space along with the beat. The tool averages your last taps for a steady BPM.",
    notes: [
      { h: "How it works", p: "Each tap records a timestamp. The BPM is 60 divided by the average gap between recent taps. Taps older than a few seconds are dropped, so the number settles quickly and recovers if you lose the beat." },
      { h: "Half-time and double-time", p: "If you tapped every second beat, or twice per beat, the answer is off by a factor of two. The tool shows both so you can pick the one that feels right for the song." },
    ],
    faq: [
      { q: "How many taps do I need?", a: "Eight or more gives a stable reading. Four is a rough guess." },
      { q: "Can I use the keyboard?", a: "Yes. Press space, or any key, in place of clicking the pad." },
    ],
  },
  {
    slug: "bpm-key-detector",
    title: "BPM and Key Detector",
    short: "Drop in a song, get BPM and Camelot key",
    description: "Free BPM and key finder. Drop in an audio file to detect tempo and musical key (with the Camelot code) locally in your browser - nothing is uploaded.",
    keyword: "bpm finder",
    intro: "Choose an audio file (mp3, m4a, wav, ogg). It is decoded and analysed on your device with the same algorithms Everplay uses for its library. Nothing is uploaded.",
    notes: [
      { h: "What it analyses", p: "Tempo comes from the pattern of onsets in the low end, with a confidence score. Key comes from the pitch-class content of the harmony and is shown as a musical key and a Camelot code." },
      { h: "What affects accuracy", p: "Songs with a steady beat give the best tempo. Songs with tempo changes, rubato or no drums are harder, and the confidence score will be low. Key detection is least certain on ambiguous or modulating harmony." },
      { h: "Privacy", p: "Your file is decoded by your browser and analysed on your device. Nothing leaves it." },
    ],
    faq: [
      { q: "Which part of the song is analysed?", a: "Up to 90 seconds starting 20 seconds in, which skips most intros. Short files are analysed whole." },
      { q: "Why is my BPM double or half?", a: "Tempo detection can lock on to half-time or double-time. If the answer feels wrong, try halving or doubling it." },
    ],
  },
  {
    slug: "camelot-wheel",
    title: "Interactive Camelot Wheel",
    short: "Find keys that mix with yours",
    description: "Interactive Camelot wheel for harmonic mixing. Pick a key to see which keys are compatible, with their musical names.",
    keyword: "camelot wheel",
    intro: "Click a key on the wheel. Green keys mix smoothly with it, amber keys are the energy moves.",
    notes: [
      { h: "The rules", p: "Same key, one step either way, or the same number with the other letter all sound good. Two steps up lifts the energy, and seven steps up is a semitone lift." },
      { h: "Reading the wheel", p: "Numbers 1-12 go around the circle of fifths. The outer ring (B) is major keys, the inner ring (A) minor keys. A number's A and B are relative keys, sharing the same notes." },
    ],
    faq: [
      { q: "What does 8A mean?", a: "A minor. Its relative major, C major, is 8B." },
      { q: "Do I have to follow the wheel?", a: "No. Short mixes, echo outs and cuts hide key clashes. It is a guide for long blends." },
    ],
  },
  {
    slug: "delay-time-calculator",
    title: "BPM to Delay Time Calculator",
    short: "BPM to milliseconds and Hz",
    description: "Convert BPM to delay and reverb pre-delay times in milliseconds for every note value, including dotted and triplet. Free, instant.",
    keyword: "bpm to ms",
    intro: "Enter a tempo and read off the delay time for every note division.",
    notes: [
      { h: "The formula", p: "A quarter note lasts 60,000 divided by the BPM, in milliseconds. A dotted note is 1.5 times that, and a triplet is two thirds of it." },
      { h: "Using it", p: "Set a delay's time to a note value so the echoes land on the grid. Dotted eighths against a straight beat give the classic rolling delay." },
    ],
    faq: [
      { q: "Why dotted and triplet?", a: "They create rhythms that sit between the straight divisions and are common for delays and gates." },
    ],
  },
  {
    slug: "pitch-tempo-calculator",
    title: "Pitch and Tempo Shift Calculator",
    short: "Percent, semitones, new BPM and key",
    description: "Convert a pitch fader percentage to semitones, new BPM and the Camelot key shift. Plan tempo changes for DJ mixing.",
    keyword: "pitch shift calculator",
    intro: "Enter a BPM and a target tempo (or a percentage, or semitones) and see all the others, plus the new Camelot key if there is no key lock.",
    notes: [
      { h: "Speed and pitch are linked", p: "Playing a record faster raises the pitch. Each semitone is a ratio of 2 to the power of 1/12, about 5.9 percent. Without key lock, a +5.9 percent change moves the song up one semitone." },
      { h: "On the Camelot wheel", p: "One semitone up moves seven steps clockwise on the wheel. Small tempo moves of a percent or two barely change the key, which is why beat-matching works." },
    ],
    faq: [
      { q: "What is key lock?", a: "Key lock (master tempo) changes tempo without changing pitch, using time-stretching. It can add small artefacts at large changes." },
    ],
  },
  {
    slug: "transition-length-calculator",
    title: "Transition Length Calculator",
    short: "Bars and beats to seconds",
    description: "Work out how long a DJ transition lasts in seconds from tempo, bars and time signature. Plan 8, 16 and 32 bar blends.",
    keyword: "bars to seconds",
    intro: "Enter a tempo and how many bars the blend should run.",
    notes: [
      { h: "The formula", p: "Seconds = beats per bar x bars x 60 / BPM. In 4/4 at 124 BPM, 16 bars lasts about 31 seconds." },
      { h: "Choosing a length", p: "Short (2-4 bars) hides differences and suits cuts and echo outs. Medium (8 bars) is the everyday blend. Long (16-32 bars) is for songs that really match." },
    ],
    faq: [
      { q: "Why do DJs count in phrases?", a: "Most dance music is built in 8- or 16-bar phrases. Starting a blend on a phrase boundary keeps the structure of both songs aligned." },
    ],
  },
  {
    slug: "bpm-cheat-sheet",
    title: "BPM Cheat Sheet by Genre and Activity",
    short: "Typical tempos for every genre and activity",
    description: "A searchable BPM cheat sheet for genres and activities: house, techno, hip hop, pop, bhangra, running, studying and more.",
    keyword: "bpm by genre",
    intro: "Search a genre or an activity to see its typical tempo range, then tap the row to see where it falls.",
    notes: [
      { h: "Ranges, not rules", p: "These are typical ranges drawn from common practice. Individual songs sit outside them all the time, and half-time feels double the numbers." },
      { h: "Using it", p: "Pick a target range for the part of your set, then look for songs inside it. Check neighbours against the Camelot wheel for a smooth blend." },
    ],
    faq: [
      { q: "Are these exact?", a: "No. They are ranges to start from." },
    ],
  },
];

export function getTool(slug: string) {
  return TOOLS.find((t) => t.slug === slug);
}
