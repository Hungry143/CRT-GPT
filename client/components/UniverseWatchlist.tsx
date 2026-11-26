'use client';

import {
  TRADING_UNIVERSE,
  type InstrumentKey,
} from '@/shared/tradingSystem/universe';

interface UniverseWatchlistProps {
  selectedInstrument: InstrumentKey;
  onSelectInstrument: (instrument: InstrumentKey) => void;
}

/**
 * Selects the display chart only. No quote, signal, or market feed data
 * is inferred from a TradingView visual widget.
 */
export function UniverseWatchlist({
  selectedInstrument,
  onSelectInstrument,
}: UniverseWatchlistProps) {
  return (
    <section
      aria-labelledby="universe-heading"
      className="rounded-lg border border-[#222D3D] bg-[#111720] overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-[#1F2937] flex flex-wrap gap-2 items-center justify-between">
        <h2 id="universe-heading" className="font-display text-sm font-semibold text-[#F8FAFC]">
          Multi-Market Watchlist
        </h2>
        <span className="text-xs text-[#8B9BB0] font-mono">14 instruments</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-px bg-[#222D3D]">
        {TRADING_UNIVERSE.map((instrument) => {
          const selected = instrument.key === selectedInstrument;
          return (
            <button
              type="button"
              key={instrument.key}
              onClick={() => onSelectInstrument(instrument.key)}
              aria-pressed={selected}
              aria-label={'Display chart for ' + instrument.key}
              className={
                'px-3 py-3 text-left min-w-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-amber-400 ' +
                (selected
                  ? 'bg-[#202A3A] text-amber-300'
                  : 'bg-[#101720] text-[#D0DAE6] hover:bg-[#192434]')
              }
            >
              <span className="block font-mono font-semibold text-xs">{instrument.key}</span>
              <span className="block mt-1 text-[10px] text-[#8B9BB0]">
                {instrument.assetClass === 'FOREX' ? 'Forex' : 'Metal'} · Chart only
              </span>
            </button>
          );
        })}
      </div>
      <div className="px-4 py-2.5 border-t border-[#1F2937] text-[11px] text-[#94A3B8]">
        A watchlist entry is NOT a live market-data connection or a CRT signal.
        All prices, signal grades and outcomes remain unavailable until verified per-instrument feeds and rules exist.
      </div>
    </section>
  );
}
