import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from 'react-email';

type MagicLinkEmailProps = {
  loginUrl?: string;
  appName?: string;
  appUrl?: string;
};

export const MagicLinkEmail = ({
  loginUrl = 'https://example.com/login',
  appName = 'App',
  appUrl = 'https://example.com',
}: MagicLinkEmailProps) => (
  <Html>
    <Head />
    <Preview>Sign in to {appName}</Preview>
    <Body style={main}>
      {/* Gradient accent bar */}
      <div style={accentBar} />

      <Container style={container}>
        {/* Header */}
        <Section style={header}>
          <Heading style={h1}>{appName}</Heading>
        </Section>

        {/* Main content */}
        <Section style={content}>
          <Heading style={h2}>Your magic link is ready</Heading>
          <Text style={paragraph}>Click below to sign in to {appName}. This link expires in 10 minutes.</Text>

          {/* CTA Button with gradient */}
          <Section style={buttonContainer}>
            <Button href={loginUrl} style={button}>
              Sign in to {appName}
            </Button>
          </Section>

          {/* Alternative link section */}
          <Hr style={hr} />
          <Text style={smallText}>Or copy and paste this link:</Text>
          <Section style={codeContainer}>
            <code style={code}>{loginUrl}</code>
          </Section>
        </Section>

        {/* Minimal footer */}
        <Section style={footer}>
          <Text style={footerText}>Didn't request this? You can safely ignore this email.</Text>
          <Text style={footerText}>
            <Link href={`${appUrl}/help`} style={footerLink}>
              Need help?
            </Link>
          </Text>
        </Section>
      </Container>
    </Body>
  </Html>
);

export default MagicLinkEmail;

// Styles
const main = {
  backgroundColor: '#ffffff',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", "Ubuntu", sans-serif',
};

const accentBar = {
  height: '4px',
  background: 'linear-gradient(90deg, #FF8C42 0%, #FFC857 50%, #4A90E2 100%)',
  margin: '0',
};

const container = {
  margin: '0 auto',
  padding: '0 40px 60px',
  maxWidth: '500px',
};

const header = {
  padding: '48px 0 0',
  textAlign: 'center' as const,
};

const h1 = {
  color: '#1a1a1a',
  fontSize: '24px',
  fontWeight: '600',
  lineHeight: '1.3',
  margin: '0',
  letterSpacing: '-0.3px',
};

const content = {
  padding: '40px 0',
  textAlign: 'center' as const,
};

const h2 = {
  color: '#1a1a1a',
  fontSize: '26px',
  fontWeight: '600',
  lineHeight: '1.4',
  margin: '0 0 12px',
  letterSpacing: '-0.3px',
};

const paragraph = {
  color: '#525252',
  fontSize: '16px',
  lineHeight: '1.6',
  margin: '0 0 32px',
};

const buttonContainer = {
  padding: '0 0 32px',
};

const button = {
  background: 'linear-gradient(135deg, #FF8C42 0%, #FFC857 100%)',
  borderRadius: '12px',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '16px 32px',
  lineHeight: '1.5',
  boxShadow: '0 4px 12px rgba(255, 140, 66, 0.3)',
  border: 'none',
};

const hr = {
  borderColor: '#e6e6e6',
  margin: '0 0 24px',
  borderTop: '1px solid #e6e6e6',
  borderBottom: 'none',
};

const smallText = {
  color: '#737373',
  fontSize: '13px',
  lineHeight: '1.5',
  margin: '0 0 12px',
};

const codeContainer = {
  backgroundColor: '#f9fafb',
  borderRadius: '8px',
  padding: '12px 16px',
  margin: '0 0 32px',
  border: '1px solid #e5e7eb',
};

const code = {
  color: '#374151',
  fontSize: '13px',
  fontFamily: '"Monaco", "Menlo", "Consolas", monospace',
  wordBreak: 'break-all' as const,
  display: 'block',
  lineHeight: '1.6',
};

const footer = {
  padding: '32px 0 0',
  textAlign: 'center' as const,
  borderTop: '1px solid #e6e6e6',
};

const footerText = {
  color: '#9ca3af',
  fontSize: '13px',
  lineHeight: '1.6',
  margin: '0 0 8px',
};

const footerLink = {
  color: '#FF8C42',
  textDecoration: 'underline',
};
