import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arki/ui/card';
import { Envelope } from '@arki/icons/phosphor';

export function VerifyRequestTemplate() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full">
            <Envelope className="h-6 w-6" />
          </div>
          <CardTitle className="mt-4 text-center text-2xl font-bold">Check your email</CardTitle>
          <CardDescription className="text-center">A sign in link has been sent to your email address.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center">
            Click the link in the email to sign in or continue with your account creation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
