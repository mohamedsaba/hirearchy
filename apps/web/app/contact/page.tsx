import { Site, Kicker, Button } from '../home/site';

export const metadata = {
  title: 'Contact — Hirearchy',
  description:
    'Buyer and demo requests are not open yet. Read about Hirearchy Software and its current internal demo, or request early access.',
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
          If you are looking to evaluate Hirearchy for your engineering team,
          explore our early-access form. A submission records interest only and
          does not create a public account or hosted pilot.
        </p>
        <div className="ct-contact-links">
          <Button href="/early-access">Request early access</Button>
          <Button href="/products/software">Explore Software</Button>
          <Button href="/products/software#demo-limits">See demo limits</Button>
        </div>
      </section>
    </Site>
  );
}
