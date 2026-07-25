import React from 'react';
import EssentialsCard from './config/EssentialsCard';
import AdvancedCard from './config/AdvancedCard';
import TargetCard from './config/TargetCard';
import { ConfigComponentProps } from './types';
import { DatasetItem } from '@/lib/replayApi';
import { RunnerFlavor } from '@/lib/jobsApi';

interface ConfigurationTabProps extends ConfigComponentProps {
  datasets: DatasetItem[];
  datasetsLoading: boolean;
  authenticated: boolean;
  flavors: RunnerFlavor[];
  hardwareLoading: boolean;
  hardwareError?: string | null;
  onRetryHardware?: () => void;
}

const ConfigurationTab: React.FC<ConfigurationTabProps> = ({
  config,
  updateConfig,
  datasets,
  datasetsLoading,
  authenticated,
  flavors,
  hardwareLoading,
  hardwareError = null,
  onRetryHardware,
}) => {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <TargetCard
        config={config}
        updateConfig={updateConfig}
        authenticated={authenticated}
        flavors={flavors}
        loading={hardwareLoading}
        hardwareError={hardwareError}
        onRetryHardware={onRetryHardware}
      />
      <EssentialsCard
        config={config}
        updateConfig={updateConfig}
        datasets={datasets}
        datasetsLoading={datasetsLoading}
      />
      <AdvancedCard config={config} updateConfig={updateConfig} />
    </div>
  );
};

export default ConfigurationTab;
