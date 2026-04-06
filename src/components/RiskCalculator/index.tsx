import { SectionBox } from '../ui';
import { useRiskCalculator } from '../../hooks/useRiskCalculator';
import RiskInputs from './RiskInputs';
import RiskResults from './RiskResults';

export default function RiskCalculator() {
  const rc = useRiskCalculator();

  return (
    <SectionBox label="Risk Calculator" collapsible>
      <RiskInputs
        mode={rc.mode}
        balance={rc.balance}
        wing={rc.wing}
        contracts={rc.contracts}
        creditInput={rc.creditInput}
        premiumInput={rc.premiumInput}
        targetExitInput={rc.targetExitInput}
        deltaInput={rc.deltaInput}
        popInput={rc.popInput}
        stopMultiple={rc.stopMultiple}
        buyStopPct={rc.buyStopPct}
        portfolioCap={rc.portfolioCap}
        setMode={rc.setMode}
        setBalance={rc.setBalance}
        setWing={rc.setWing}
        setContracts={rc.setContracts}
        setCreditInput={rc.setCreditInput}
        setPremiumInput={rc.setPremiumInput}
        setTargetExitInput={rc.setTargetExitInput}
        setDeltaInput={rc.setDeltaInput}
        setPopInput={rc.setPopInput}
        setStopMultiple={rc.setStopMultiple}
        setBuyStopPct={rc.setBuyStopPct}
        setPortfolioCap={rc.setPortfolioCap}
        credit={rc.credit}
        premium={rc.premium}
        delta={rc.delta}
        hasDelta={rc.hasDelta}
        hasCredit={rc.hasCredit}
        hasStop={rc.hasStop}
        hasTarget={rc.hasTarget}
        hasBuyStop={rc.hasBuyStop}
        creditPct={rc.creditPct}
        buyProfitPerContract={rc.buyProfitPerContract}
        rrRatio={rc.rrRatio}
      />

      {/* ── RESULTS ── */}
      {rc.bal > 0 && rc.lossPerContract > 0 && (
        <RiskResults
          mode={rc.mode}
          contracts={rc.contracts}
          setContracts={rc.setContracts}
          portfolioCap={rc.portfolioCap}
          bal={rc.bal}
          hasCredit={rc.hasCredit}
          grossLossPerContract={rc.grossLossPerContract}
          netLossPerContract={rc.netLossPerContract}
          premiumPerContract={rc.premiumPerContract}
          hasTarget={rc.hasTarget}
          buyProfitPerContract={rc.buyProfitPerContract}
          totalLoss={rc.totalLoss}
          lossPct={rc.lossPct}
          totalBp={rc.totalBp}
          rrRatio={rc.rrRatio}
          maxPositions={rc.maxPositions}
          hasPop={rc.hasPop}
          evPerContract={rc.evPerContract}
          maxProfit={rc.maxProfit}
          lossPerContract={rc.lossPerContract}
        />
      )}
    </SectionBox>
  );
}
