"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight20Regular,
  CheckmarkCircle20Regular,
  DocumentSearch20Regular,
  Ruler20Regular,
  ShieldCheckmark20Regular,
} from "@fluentui/react-icons";
import { SiteHeader } from "./components/SiteHeader";

export default function LandingPage() {
  return (
    <div className="landing-root">
      <SiteHeader />

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-art-stage">
            <Image
              className="landing-art"
              src="/rackwise-editorial-build.png"
              alt="Pixel workers assembling a Eurorack system from modules, rails and orange patch cables"
              width={1664}
              height={944}
              sizes="100vw"
              priority
              quality={100}
              unoptimized
              draggable={false}
            />

            <div className="landing-headline">
              <p>Evidence-led Eurorack planning</p>
              <h1 id="landing-title">Know what<br /><em>fits.</em></h1>
            </div>

            <Link className="landing-primary-cta" href="/playground">
              Open playground <ArrowRight20Regular />
            </Link>

            <a className="landing-secondary-cta" href="#method">
              <span>How Rackwise reaches an answer</span>
              <small>03 steps</small>
              <ArrowRight20Regular />
            </a>
          </div>
        </section>

        <section className="landing-method" id="method" aria-labelledby="method-title">
          <div className="landing-section-heading">
            <p>How a decision is made</p>
            <h2 id="method-title">Follow the<br />signal.</h2>
            <span>Every answer travels through calculation, retrieval and an explicit evidence decision.</span>
          </div>
          <div className="decision-path" aria-label="Rackwise decision path">
            <span className="decision-cable" aria-hidden="true" />
            <article>
              <pre aria-hidden="true">{"|::| 20HP\n|::| 45mm\n|::| +12V"}</pre>
              <div className="decision-step"><span><Ruler20Regular /></span><strong>01 / CALCULATE</strong></div>
              <h3>Measure the rack</h3><p>Width, depth and every power rail are checked deterministically.</p>
            </article>
            <article>
              <pre aria-hidden="true">{"SOURCE\n:::::::\nCLAIM >"}</pre>
              <div className="decision-step"><span><DocumentSearch20Regular /></span><strong>02 / RETRIEVE</strong></div>
              <h3>Read the sources</h3><p>The agent retrieves structured claims from the Sanity Knowledge Base.</p>
            </article>
            <article>
              <pre aria-hidden="true">{"EX != NT\nVERIFY?\n[ YES ]"}</pre>
              <div className="decision-step"><span><ShieldCheckmark20Regular /></span><strong>03 / DECIDE</strong></div>
              <h3>Keep claims honest</h3><p>Missing coverage and model variants remain visible instead of being guessed.</p>
            </article>
          </div>
        </section>

        <section className="landing-evidence" id="evidence" aria-labelledby="evidence-title">
          <div className="evidence-statement">
            <span aria-hidden="true"><CheckmarkCircle20Regular /></span>
            <div><p>Source-backed by design</p><h2 id="evidence-title">See the gap before it becomes a mistake.</h2></div>
          </div>
          <div className="evidence-example" aria-label="Example evidence decision">
            <div><span>Selected</span><strong>Disting EX</strong></div>
            <b aria-hidden="true">→</b>
            <div><span>Source found</span><strong>Disting NT</strong></div>
            <b aria-hidden="true">→</b>
            <div><span>Decision</span><strong>Different variant</strong></div>
          </div>
          <div className="evidence-explanation">
            <p>Rackwise keeps these models separate instead of borrowing the wrong width, depth or power specifications.</p>
            <Link href="/playground">Test the live workflow <ArrowRight20Regular /></Link>
          </div>
        </section>
      </main>
    </div>
  );
}
