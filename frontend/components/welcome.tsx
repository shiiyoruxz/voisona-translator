import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface WelcomeProps {
  disabled: boolean;
  startButtonText: string;
  onStartCall: () => void;
}

export const Welcome = ({
  disabled,
  startButtonText,
  onStartCall,
  ref,
}: React.ComponentProps<'div'> & WelcomeProps) => {
  return (
    <section
      ref={ref}
      inert={disabled}
      className={cn(
        'bg-background fixed inset-0 mx-auto flex h-svh flex-col items-center justify-center text-center',
        disabled ? 'z-10' : 'z-20'
      )}
    >
      {/* WWF Logo */}
      <div className="mb-6">
        <img src="/WWF-Logo.svg" alt="WWF Logo" className="mx-auto h-30 w-30" />
      </div>

      <h1 className="mb-2 text-3xl font-bold text-green-600">WWF Conservation Assistant</h1>
      <p className="text-fg1 max-w-prose pt-1 leading-6 font-medium">
        Chat with our AI assistant about wildlife conservation and support WWF's mission
      </p>
      <Button variant="primary" size="lg" onClick={onStartCall} className="mt-6 w-64 font-mono">
        {startButtonText}
      </Button>
      <footer className="fixed bottom-5 left-0 z-20 flex w-full items-center justify-center">
        <p className="text-fg1 max-w-prose pt-1 text-xs leading-5 font-normal text-pretty md:text-sm">
          Learn more about{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.worldwildlife.org"
            className="text-green-600 underline"
          >
            WWF's conservation work
          </a>{' '}
          and how you can help protect wildlife.
        </p>
      </footer>
    </section>
  );
};
