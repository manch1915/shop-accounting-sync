import { type NextRequest, NextResponse } from 'next/server';

// Cheap gate: no cookie, no dashboard. The API still checks the session on every call.
export function proxy(request: NextRequest) {
  if (!request.cookies.has('sas_session')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!login|api|webhooks|sandbox|_next|favicon.ico|icon.svg|robots.txt).*)'],
};
