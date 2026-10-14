import { Card, CardContent, CardHeader, CardTitle } from '@arki/ui/card';
import { CircleNotch } from '@arki/icons/phosphor';

export function SignOutTemplate() {
  return (
    <div className="justify-cente flex min-h-screen items-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-2xl font-bold">Signing Out</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center">
          <CircleNotch className="h-8 w-8 animate-spin" />
          <p className="mt-4 text-center">Please wait while you are being logged out...</p>
        </CardContent>
      </Card>
    </div>
  );
}
