import { Site, Kicker, Button } from '../home/site';

export const metadata = {
  title: 'Contact',
  description:
    'Buyer and demo requests are not open yet. Read about Hirearchy Software and its current internal demo.',
};

export default function ContactPage() {
  return (
    <Site>
      <section className="ct-page-hero ct-page-hero--white ct-reveal">
        <Kicker>Contact / Availability</Kicker>
        <h1 className="ct-enter">Buyer and demo requests are not open yet.</h1>
        <p>
          This page is informational only. It does not accept or store messages.
        </p>
      </section>
      <section className="ct-editorial ct-editorial--lilac ct-reveal">
        <h2 className="ct-enter">Explore Hirearchy Software.</h2>
        <p>
          Read about the internal demo, what it supports and its current limits.
        </p>
        <Button href="/products/software">Explore Software</Button>
        <Button href="/products/software#demo-limits">See demo limits</Button>
      </section>
    </Site>
  );
}
