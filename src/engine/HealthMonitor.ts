export interface ProviderHealth {
	lastSuccess: number;
	failures: number;
	avgLatencyMs: number;
	totalRequests: number;
}

export class HealthMonitor {
	private stats = new Map<string, ProviderHealth>();

	private getOrCreate(provider: string): ProviderHealth {
		let stat = this.stats.get(provider);
		if (!stat) {
			stat = {
				lastSuccess: 0,
				failures: 0,
				avgLatencyMs: 0,
				totalRequests: 0,
			};
			this.stats.set(provider, stat);
		}
		return stat;
	}

	recordSuccess(provider: string, durationMs: number): void {
		const stat = this.getOrCreate(provider);
		stat.lastSuccess = Date.now();
		stat.failures = 0; // Reset failures on successful completion
		stat.totalRequests += 1;
		// Exponential moving average for latency
		if (stat.avgLatencyMs === 0) {
			stat.avgLatencyMs = durationMs;
		} else {
			stat.avgLatencyMs = Math.round(stat.avgLatencyMs * 0.7 + durationMs * 0.3);
		}
	}

	recordFailure(provider: string): void {
		const stat = this.getOrCreate(provider);
		stat.failures += 1;
	}

	isHealthy(provider: string): boolean {
		const stat = this.stats.get(provider);
		if (!stat) { return true; } // Default to healthy
		// Consider unhealthy if 3 or more consecutive/recent failures
		return stat.failures < 3;
	}

	getStats(provider: string): ProviderHealth | undefined {
		return this.stats.get(provider);
	}

	clear(): void {
		this.stats.clear();
	}
}

export const healthMonitor = new HealthMonitor();
