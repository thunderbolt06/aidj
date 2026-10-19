import type { Metadata } from "next";
import { PageHero } from "@/components/site/PageHero";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Everplay stores and what it does not: a sign-in cookie, anonymous listening events, and local settings in your browser.",
  alternates: { canonical: "/privacy" },
};

export default function Privacy() {
  return (
    <>
      <PageHero eyebrow="Privacy" title="What Everplay knows about you." lede="Short and plain. This describes what the software does today." />
      <section className="ep-section">
        <div className="ep-narrow ep-prose">
          <h2>On this website</h2>
          <p>The pages you are reading set no tracking cookies and load no third-party analytics. The free tools run in your browser. When you give the BPM and key detector a file, it is decoded and analysed on your device and is not uploaded.</p>
          <h2>In the app</h2>
          <ul>
            <li><strong>Sign-in cookie.</strong> After you sign in, a session cookie keeps you signed in.</li>
            <li><strong>Anonymous listening events.</strong> The player sends batched events: sets started, songs played, and how each ended (finished, skipped and so on). They are keyed to a random identifier your browser keeps in local storage. There is no name, email or account attached.</li>
            <li><strong>Your settings.</strong> Preferences such as language and the song library you chose are kept in your browser&apos;s local storage.</li>
            <li><strong>Microphone.</strong> Voice features (vibe by voice, talking DJ, Sing-It Showdown) use your microphone only when you turn them on, and your browser asks first.</li>
            <li><strong>AI services.</strong> To plan transitions and write banter, details of the songs in your set and what you typed or said may be sent to AI providers.</li>
          </ul>
          <h2>What we do not do</h2>
          <ul>
            <li>Sell your data.</li>
            <li>Show advertising.</li>
            <li>Build a profile tied to your identity.</li>
          </ul>
          <h2>Clearing it</h2>
          <p>Clearing your browser&apos;s site data removes the cookie, the random identifier and your settings. A new identifier is created the next time you listen.</p>
          <p className="text-sm text-[#8aa0ab]">This page is a plain-language description, not legal advice or a contract.</p>
        </div>
      </section>
    </>
  );
}
