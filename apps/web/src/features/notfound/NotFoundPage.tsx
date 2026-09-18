import { Compass } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { Button, EmptyState, Link } from '@financialos/ui';
import { withContext } from '../../lib/context';

export function Component() {
  const [params] = useSearchParams();
  return (
    <EmptyState
      icon={<Compass size={22} />}
      title="Page not found"
      description="That address does not match anything in FinancialOS."
      actions={
        <Button asChild variant="primary" size="sm">
          <Link href={withContext('/today', params)} variant="plain">
            Go to Today
          </Link>
        </Button>
      }
    />
  );
}
