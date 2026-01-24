import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="text-center">
        <p className="text-sm text-muted">404</p>
        <h1 className="mt-1 text-xl font-semibold">This page does not exist</h1>
        <Link href="/" className="mt-4 inline-block text-accent hover:underline">
          Back to the overview
        </Link>
      </div>
    </main>
  );
}
