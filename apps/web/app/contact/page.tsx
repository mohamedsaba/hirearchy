import { Site, Kicker, Button } from '../home/site';

export const metadata = {
  title: 'Contact',
  description:
    'Buyer and demo requests are not open yet. Read about Hirearchy Software and its current internal demo.',
};

export default function ContactPage() {
  return (
    <Site>
      <section
        className="ct-page-hero ct-page-hero--white ct-reveal"
        style={{ minHeight: 0 }}
      >
        <Kicker>Contact / Availability</Kicker>
        <h1 className="ct-enter">Buyer and demo requests are not open yet.</h1>
        <p>
          This page is informational only. It does not accept or store messages.
        </p>
        <div className="ct-contact-links">
          <Button href="/products/software">Explore Software</Button>
          <Button href="/products/software#demo-limits">See demo limits</Button>
        </div>
      </section>
    </Site>
  );
}
