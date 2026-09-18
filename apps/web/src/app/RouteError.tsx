import { isRouteErrorResponse, useRouteError } from 'react-router';
import { Button, ErrorState } from '@financialos/ui';

export function RouteError() {
  const error = useRouteError();
  const chunkFailed = error instanceof Error && /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message);
  const title = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : chunkFailed ? 'FinancialOS was updated' : 'This screen failed to load';
  const description = chunkFailed
    ? 'A newer version is available. Reload to continue.'
    : 'Something unexpected happened while showing this screen. Your data is safe on the server.';
  return (
    <div className="fos-public">
      <main className="fos-public__main">
        <div className="fos-public__card">
          <ErrorState
            title={title}
            description={description}
            actions={
              <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
                Reload
              </Button>
            }
          />
        </div>
      </main>
    </div>
  );
}
