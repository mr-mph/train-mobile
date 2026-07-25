
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FileText } from 'lucide-react';
import { LogEntry } from '../types';

interface TrainingLogsProps {
  logs: LogEntry[];
  logContainerRef: React.RefObject<HTMLDivElement>;
}

const TrainingLogs: React.FC<TrainingLogsProps> = ({ logs, logContainerRef }) => {
  return (
    <Card className="bg-black border-zinc-800 rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-white">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-900">
            <FileText className="w-5 h-5 text-green-400" />
          </div>
          Training Logs
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          ref={logContainerRef}
          className="bg-black rounded-lg p-4 h-96 overflow-y-auto font-mono text-sm border border-zinc-800"
        >
          {logs.length === 0 ? (
            <div className="text-zinc-500 py-8">
              No training logs yet. Start training to see output.
            </div>
          ) : (
            logs.map((log, index) => (
              <div
                key={index}
                className="text-zinc-300 break-words whitespace-pre-wrap"
              >
                <span className="text-zinc-500 mr-2 select-none">
                  {new Date(log.timestamp * 1000).toLocaleTimeString()}
                </span>
                {log.message}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default TrainingLogs;
