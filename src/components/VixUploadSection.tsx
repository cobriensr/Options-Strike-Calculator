import { SectionBox } from './ui';

interface Props {
  vixDataLoaded: boolean;
  vixDataSource: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export default function VixUploadSection({
  vixDataLoaded,
  vixDataSource,
  fileInputRef,
  onFileUpload,
}: Readonly<Props>) {
  return (
    <SectionBox
      label="Historical VIX Data"
      badge={vixDataLoaded ? vixDataSource : null}
      collapsible
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={onFileUpload}
        className="hidden"
        aria-label="Upload VIX OHLC CSV file"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        className={
          'w-full cursor-pointer rounded-lg border-2 border-dashed p-3 font-sans text-sm font-semibold ' +
          (vixDataLoaded
            ? 'bg-surface-alt border-edge-strong text-secondary'
            : 'bg-accent-bg border-accent text-accent')
        }
      >
        {vixDataLoaded ? 'Replace CSV' : 'Upload VIX OHLC CSV'}
      </button>
      <p className="text-muted mt-1.5 mb-0 text-xs">
        CSV with Date, Open, High, Low, Close columns
      </p>
    </SectionBox>
  );
}
