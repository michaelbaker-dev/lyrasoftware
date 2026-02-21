interface Step {
  name: string;
  description?: string;
}

interface StepProgressProps {
  steps: Step[];
  currentStep: number;
  statuses: ("pending" | "running" | "completed" | "failed")[];
  onStepClick?: (index: number) => void;
}

export default function StepProgress({ steps, currentStep, statuses, onStepClick }: StepProgressProps) {
  const statusStyles = {
    pending: {
      circle: "bg-gray-700 border-gray-600",
      text: "text-gray-500",
      line: "bg-gray-700"
    },
    running: {
      circle: "bg-blue-500 border-blue-400 animate-pulse",
      text: "text-blue-400",
      line: "bg-gray-700"
    },
    completed: {
      circle: "bg-green-500 border-green-400",
      text: "text-green-400",
      line: "bg-green-500"
    },
    failed: {
      circle: "bg-red-500 border-red-400",
      text: "text-red-400",
      line: "bg-red-500"
    }
  };

  const compact = steps.length > 6;

  return (
    <div className="w-full overflow-x-auto">
      <div className={`flex items-center ${compact ? "min-w-0" : "justify-between"}`}>
        {steps.map((step, idx) => {
          const status = statuses[idx] || "pending";
          const isCurrent = idx === currentStep;
          const styles = statusStyles[status];
          const isLast = idx === steps.length - 1;
          const clickable = Boolean(onStepClick);

          return (
            <div key={idx} className="flex items-center flex-1 min-w-0">
              <div
                className={`flex flex-col items-center min-w-0 ${clickable ? "cursor-pointer group" : ""}`}
                onClick={clickable ? () => onStepClick!(idx) : undefined}
              >
                <div
                  className={`${compact ? "w-7 h-7" : "w-8 h-8"} rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                    isCurrent && status !== "completed" && status !== "failed"
                      ? "bg-blue-500 border-blue-400"
                      : styles.circle
                  } ${clickable ? "group-hover:ring-2 group-hover:ring-blue-400/50" : ""}`}
                >
                  {status === "completed" && (
                    <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                  {status === "failed" && (
                    <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                  {status !== "completed" && status !== "failed" && (
                    <span className={`text-xs font-medium ${isCurrent ? "text-white" : styles.text}`}>{idx + 1}</span>
                  )}
                </div>
                <div className="mt-2 text-center min-w-0">
                  <p className={`${compact ? "text-[11px]" : "text-sm"} font-medium whitespace-nowrap ${
                    isCurrent ? "text-blue-400" : styles.text
                  }`}>{step.name}</p>
                  {step.description && (
                    <p className={`${compact ? "text-[10px] leading-tight" : "text-xs"} text-gray-500 mt-1 max-w-[85px] line-clamp-2`}>{step.description}</p>
                  )}
                </div>
              </div>
              {!isLast && (
                <div className={`flex-1 h-0.5 ${compact ? "mx-1" : "mx-2"} mt-[-40px]`}>
                  <div
                    className={`h-full ${
                      statuses[idx] === "completed" ? styles.line : "bg-gray-700"
                    } transition-all`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
