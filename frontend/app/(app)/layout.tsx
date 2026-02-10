import { headers } from 'next/headers';
import { getAppConfig } from '@/lib/utils';

interface AppLayoutProps {
  children: React.ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps) {
  const hdrs = await headers();
  const { companyName } = await getAppConfig(hdrs);

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 flex w-full flex-row items-center gap-2 sm:gap-3 px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-4 lg:px-8 xl:px-10 safe-area-top safe-area-x min-h-[52px] sm:min-h-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/leur.jpg"
          alt="ルウル Assistant Icon"
          className="h-8 w-8 sm:h-10 sm:w-10 rounded-full border border-white/20 shadow-md shrink-0"
        />
        <div className="flex flex-col min-w-0">
          <span className="text-xs sm:text-sm font-semibold text-white truncate">{companyName}</span>
          <span className="text-[10px] sm:text-xs text-white/60 truncate">Japanese Voice Translator</span>
        </div>
      </header>
      {children}
    </>
  );
}
