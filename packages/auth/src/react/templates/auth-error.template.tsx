import { Link } from '@tanstack/react-router';

import { Button } from '@arki/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@arki/ui/card';
import { WarningCircle } from '@arki/icons/phosphor';

export function AuthErrorPageTemplate({ error }: { error: string }) {
  const getErrorMessage = (errorCode: string) => {
    switch (errorCode) {
      case 'Configuration': {
        return 'There is a problem with the server configuration. Please try again later.';
      }
      case 'AccessDenied': {
        return 'Access denied. You do not have permission to sign in.';
      }
      case 'Verification': {
        return 'The verification token has expired or has already been used.';
      }
      default: {
        return 'An unexpected error occurred. Please try again.';
      }
    }
  };

  const errorMessage = error ? getErrorMessage(error) : 'An authentication error occurred.';

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="bg-destructive mx-auto flex h-12 w-12 items-center justify-center rounded-full">
            <WarningCircle className="text-destructive-foreground h-6 w-6" />
          </div>
          <CardTitle className="mt-4 text-center text-2xl font-bold">Authentication Error</CardTitle>
          <CardDescription className="text-center">
            We encountered a problem while trying to authenticate you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center">{errorMessage}</p>
        </CardContent>
        <CardFooter className="flex justify-center">
          <Button asChild>
            <Link to="/sign-in">Return to Sign In</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
