"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft20Regular, ArrowRight20Regular } from "@fluentui/react-icons";
import { usePathname } from "next/navigation";

export function SiteHeader() {
  const pathname = usePathname();
  const inPlayground = pathname === "/playground";
  return (
    <header className="landing-nav site-header">
      <Link className="landing-brand" href="/" aria-label="Rackwise home">
        <span className="landing-brand-mark" aria-label="Rackwise">
          <span className="new-brand-logo" aria-hidden="true">
            <Image src="/rackwise-brand-logo.png" alt="" width={1536} height={1024} priority />
          </span>
          <strong>Rackwise</strong>
        </span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link href="/#method">How it works</Link>
        <Link href="/#evidence">Evidence</Link>
        <Link href="/playground">Playground</Link>
      </nav>
      <Link className="landing-nav-cta" href={inPlayground ? "/" : "/playground"}>{inPlayground ? <><ArrowLeft20Regular /> Back to home</> : <>Try the demo <ArrowRight20Regular /></>}</Link>
    </header>
  );
}
