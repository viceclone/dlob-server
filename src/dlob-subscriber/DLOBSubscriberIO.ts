import {
	BN,
	DLOBSubscriber,
	DLOBSubscriptionConfig,
	L2OrderBookGenerator,
	MarketType,
	groupL2,
	isVariant,
} from '@drift-labs/sdk';
import { RedisClient } from '../utils/redisClient';
import {
	SubscriberLookup,
	addMarketSlotToResponse,
	addOracletoResponse,
	l2WithBNToStrings,
} from '../utils/utils';

type wsMarketL2Args = {
	marketIndex: number;
	marketType: MarketType;
	marketName: string;
	depth: number;
	includeVamm: boolean;
	numVammOrders?: number;
	grouping?: number;
	fallbackL2Generators?: L2OrderBookGenerator[];
	updateOnChange?: boolean;
};

const PERP_MAKRET_STALENESS_THRESHOLD = 10 * 60 * 1000;
const SPOT_MAKRET_STALENESS_THRESHOLD = 20 * 60 * 1000;

export type wsMarketInfo = {
	marketIndex: number;
	marketName: string;
};

export class DLOBSubscriberIO extends DLOBSubscriber {
	public marketL2Args: wsMarketL2Args[] = [];
	public lastSeenL2Formatted: Map<MarketType, Map<number, any>>;
	redisClient: RedisClient;
	public killSwitchSlotDiffThreshold: number;
	public lastMarketSlotMap: Map<
		MarketType,
		Map<number, { slot: number; ts: number }>
	>;

	constructor(
		config: DLOBSubscriptionConfig & {
			redisClient: RedisClient;
			perpMarketInfos: wsMarketInfo[];
			spotMarketInfos: wsMarketInfo[];
			spotMarketSubscribers: SubscriberLookup;
			killSwitchSlotDiffThreshold?: number;
		}
	) {
		super(config);
		this.redisClient = config.redisClient;
		this.killSwitchSlotDiffThreshold =
			config.killSwitchSlotDiffThreshold || 200;

		// Set up appropriate maps
		this.lastSeenL2Formatted = new Map();
		this.lastSeenL2Formatted.set(MarketType.SPOT, new Map());
		this.lastSeenL2Formatted.set(MarketType.PERP, new Map());
		this.lastMarketSlotMap = new Map();
		this.lastMarketSlotMap.set(MarketType.SPOT, new Map());
		this.lastMarketSlotMap.set(MarketType.PERP, new Map());

		for (const market of config.perpMarketInfos) {
			const perpMarket = this.driftClient.getPerpMarketAccount(
				market.marketIndex
			);
			const includeVamm = !isVariant(perpMarket.status, 'ammPaused');

			this.marketL2Args.push({
				marketIndex: market.marketIndex,
				marketType: MarketType.PERP,
				marketName: market.marketName,
				depth: -1,
				numVammOrders: 100,
				includeVamm,
				updateOnChange: false,
				fallbackL2Generators: [],
			});
		}
		for (const market of config.spotMarketInfos) {
			this.marketL2Args.push({
				marketIndex: market.marketIndex,
				marketType: MarketType.SPOT,
				marketName: market.marketName,
				depth: -1,
				includeVamm: false,
				updateOnChange: false,
				fallbackL2Generators: [
					config.spotMarketSubscribers[market.marketIndex].phoenix,
					config.spotMarketSubscribers[market.marketIndex].serum,
				].filter((a) => !!a),
			});
		}
	}

	override async updateDLOB(): Promise<void> {
		await super.updateDLOB();
		for (const l2Args of this.marketL2Args) {
			try {
				this.getL2AndSendMsg(l2Args);
			} catch (error) {
				console.error(error);
				console.log(`Error getting L2 ${l2Args.marketName}`);
			}
		}
	}

	getL2AndSendMsg(l2Args: wsMarketL2Args): void {
		const grouping = l2Args.grouping;
		const { marketName, ...l2FuncArgs } = l2Args;
		const l2 = this.getL2(l2FuncArgs);
		const slot = l2.slot;
		const lastMarketSlotAndTime = this.lastMarketSlotMap
			.get(l2Args.marketType)
			.get(l2Args.marketIndex);
		if (!lastMarketSlotAndTime) {
			this.lastMarketSlotMap
				.get(l2Args.marketType)
				.set(l2Args.marketIndex, { slot, ts: Date.now() });
		}

		if (slot) {
			delete l2.slot;
		}
		const marketType = isVariant(l2Args.marketType, 'perp') ? 'perp' : 'spot';
		let l2Formatted: any;
		if (grouping) {
			const groupingBN = new BN(grouping);
			l2Formatted = l2WithBNToStrings(groupL2(l2, groupingBN, l2Args.depth));
		} else {
			l2Formatted = l2WithBNToStrings(l2);
		}

		if (l2Args.updateOnChange) {
			if (
				this.lastSeenL2Formatted
					.get(l2Args.marketType)
					?.get(l2Args.marketIndex) === JSON.stringify(l2Formatted)
			)
				return;
		}

		this.lastSeenL2Formatted
			.get(l2Args.marketType)
			?.set(l2Args.marketIndex, JSON.stringify(l2Formatted));
		l2Formatted['marketName'] = marketName?.toUpperCase();
		l2Formatted['marketType'] = marketType?.toLowerCase();
		l2Formatted['marketIndex'] = l2Args.marketIndex;
		l2Formatted['ts'] = Date.now();
		l2Formatted['slot'] = slot;
		addOracletoResponse(
			l2Formatted,
			this.driftClient,
			l2Args.marketType,
			l2Args.marketIndex
		);
		addMarketSlotToResponse(
			l2Formatted,
			this.driftClient,
			l2Args.marketType,
			l2Args.marketIndex
		);

		// Check if slot diffs are too large for oracle
		if (
			Math.abs(slot - parseInt(l2Formatted['oracleData']['slot'])) >
			this.killSwitchSlotDiffThreshold
		) {
			console.log(`Killing process due to slot diffs for market ${marketName}: 
				dlobProvider slot: ${slot}
				oracle slot: ${l2Formatted['oracleData']['slot']}
			`);
			process.exit(1);
		}

		// Check if times and slots are too different for market
		const MAKRET_STALENESS_THRESHOLD =
			marketType === 'perp'
				? PERP_MAKRET_STALENESS_THRESHOLD
				: SPOT_MAKRET_STALENESS_THRESHOLD;
		if (
			lastMarketSlotAndTime &&
			l2Formatted['marketSlot'] === lastMarketSlotAndTime.slot &&
			Date.now() - lastMarketSlotAndTime.ts > MAKRET_STALENESS_THRESHOLD
		) {
			console.log(`Killing process due to same slot for market ${marketName} after > ${MAKRET_STALENESS_THRESHOLD}ms: 
				dlobProvider slot: ${slot}
				market slot: ${l2Formatted['marketSlot']}
			`);
			process.exit(1);
		} else if (
			lastMarketSlotAndTime &&
			l2Formatted['marketSlot'] !== lastMarketSlotAndTime.slot
		) {
			console.log(
				`Updating market slot for ${l2Args.marketName} with slot ${l2Formatted['marketSlot']}`
			);
			this.lastMarketSlotMap.get(l2Args.marketType).set(l2Args.marketIndex, {
				slot: l2Formatted['marketSlot'],
				ts: Date.now(),
			});
		}

		const l2Formatted_depth100 = Object.assign({}, l2Formatted, {
			bids: l2Formatted.bids.slice(0, 100),
			asks: l2Formatted.asks.slice(0, 100),
		});
		const l2Formatted_depth20 = Object.assign({}, l2Formatted, {
			bids: l2Formatted.bids.slice(0, 20),
			asks: l2Formatted.asks.slice(0, 20),
		});
		const l2Formatted_depth5 = Object.assign({}, l2Formatted, {
			bids: l2Formatted.bids.slice(0, 5),
			asks: l2Formatted.asks.slice(0, 5),
		});

		this.redisClient.client.publish(
			`orderbook_${marketType}_${l2Args.marketIndex}`,
			JSON.stringify(l2Formatted)
		);
		this.redisClient.client.set(
			`last_update_orderbook_${marketType}_${l2Args.marketIndex}`,
			JSON.stringify(l2Formatted_depth100)
		);
		this.redisClient.client.set(
			`last_update_orderbook_${marketType}_${l2Args.marketIndex}_depth_100`,
			JSON.stringify(l2Formatted_depth100)
		);
		this.redisClient.client.set(
			`last_update_orderbook_${marketType}_${l2Args.marketIndex}_depth_20`,
			JSON.stringify(l2Formatted_depth20)
		);
		this.redisClient.client.set(
			`last_update_orderbook_${marketType}_${l2Args.marketIndex}_depth_5`,
			JSON.stringify(l2Formatted_depth5)
		);
	}
}
