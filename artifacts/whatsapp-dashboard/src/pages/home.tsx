import { Link } from "wouter";
import { MessageSquare, Repeat, Radio, Clock, Users, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

const features = [
  { icon: MessageSquare, title: "Message monitoring", desc: "See every conversation your bot handles in one live log." },
  { icon: Repeat, title: "Auto-replies", desc: "Answer common questions automatically, around the clock." },
  { icon: Radio, title: "Broadcasts", desc: "Reach all your contacts with a single scheduled message." },
  { icon: Clock, title: "Scheduled statuses", desc: "Queue status updates to post at exactly the right time." },
  { icon: Users, title: "Group moderation", desc: "Keep groups clean with anti-link and admin tools." },
  { icon: ShieldCheck, title: "Private & isolated", desc: "Your WhatsApp, your data — visible only to you." },
];

export default function Home() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="flex items-center justify-between px-6 py-5 max-w-6xl mx-auto">
        <div className="flex items-center gap-2 font-bold text-lg">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
            <MessageSquare size={20} />
          </div>
          WADash
        </div>
        <div className="flex items-center gap-2">
          <Link href="/sign-in">
            <Button variant="ghost" data-testid="link-sign-in">Sign in</Button>
          </Link>
          <Link href="/sign-up">
            <Button data-testid="link-sign-up">Get started</Button>
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6">
        <section className="text-center py-20 md:py-28">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-4 py-1.5 text-sm text-muted-foreground mb-6">
            <span className="w-2 h-2 rounded-full bg-primary" />
            WhatsApp automation, on autopilot
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight max-w-3xl mx-auto">
            Run your WhatsApp bot from one clean dashboard
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            Pair WhatsApp through Telegram, then monitor messages, auto-replies,
            broadcasts, scheduled statuses, and group moderation — all in a
            private dashboard scoped to just your account.
          </p>
          <div className="mt-9 flex items-center justify-center gap-3">
            <Link href="/sign-up">
              <Button size="lg" data-testid="cta-get-started">Get started free</Button>
            </Link>
            <Link href="/sign-in">
              <Button size="lg" variant="outline" data-testid="cta-sign-in">I already have an account</Button>
            </Link>
          </div>
        </section>

        <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 pb-24">
          {features.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="rounded-xl border border-border bg-card p-6">
                <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center mb-4">
                  <Icon size={20} />
                </div>
                <h3 className="font-semibold mb-1">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.desc}</p>
              </div>
            );
          })}
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-6 text-sm text-muted-foreground">
          WADash — WhatsApp bot & dashboard
        </div>
      </footer>
    </div>
  );
}
