export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse space-y-4 motion-reduce:animate-none">
      <div className="h-8 w-48 rounded bg-sunken" />
      <div className="h-4 w-80 max-w-full rounded bg-sunken" />
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="h-24 rounded-lg bg-sunken" />
        <div className="h-24 rounded-lg bg-sunken" />
      </div>
      <div className="h-64 rounded-lg bg-sunken" />
    </div>
  );
}
