import { Link } from '@tanstack/react-router';

import { ArrowLeftIcon } from '@arki/icons/phosphor';

export function LoginTemplate1({
  slots,
}: {
  slots: {
    form: React.ReactNode;
  };
}) {
  return (
    <div className="mx-auto flex h-screen w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <Link to="/" className="text-muted-foreground flex cursor-pointer items-center space-x-2 text-sm">
        <ArrowLeftIcon /> Back
      </Link>
      <div className="flex flex-col space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Sign In</h1>
        <p className="text-muted-foreground text-sm">Enter your email below to get access to your account.</p>
      </div>
      {slots.form}
      <p className="text-muted-foreground px-8 text-center text-sm">
        By clicking continue, you agree to our{' '}
        <Link to="/legal/terms" className="hover:text-primary underline underline-offset-4">
          Terms of Service
        </Link>{' '}
        and{' '}
        <Link to="/legal/privacy" className="hover:text-primary underline underline-offset-4">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}
