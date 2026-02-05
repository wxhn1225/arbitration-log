export namespace main {
	
	export class AnalyzeRequest {
	    logPath: string;
	    recentCount: number;
	    minDuration: number;
	
	    static createFrom(source: any = {}) {
	        return new AnalyzeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.logPath = source["logPath"];
	        this.recentCount = source["recentCount"];
	        this.minDuration = source["minDuration"];
	    }
	}
	export class NodeInfo {
	    NodeID: string;
	    NodeName: string;
	    SystemName: string;
	    MissionType: string;
	    Faction: string;
	
	    static createFrom(source: any = {}) {
	        return new NodeInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.NodeID = source["NodeID"];
	        this.NodeName = source["NodeName"];
	        this.SystemName = source["SystemName"];
	        this.MissionType = source["MissionType"];
	        this.Faction = source["Faction"];
	    }
	}
	export class MissionResult {
	    Index: number;
	    NodeID: string;
	    MissionName: string;
	    StartKind: string;
	    StartLine: number;
	    EndLine?: number;
	    StartTime?: number;
	    EndTime?: number;
	    DurationSec?: number;
	    StateStartedTime?: number;
	    StateEndingTime?: number;
	    StateDurationSec?: number;
	    SpawnedAtEnd?: number;
	    FirstOnAgentCreatedTime?: number;
	    LastOnAgentCreatedTime?: number;
	    OnAgentCreatedSpanSec?: number;
	    ShieldDronePerMin?: number;
	    ShieldDroneCount: number;
	    Status: string;
	    Note: string;
	    NodeInfo?: NodeInfo;
	
	    static createFrom(source: any = {}) {
	        return new MissionResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Index = source["Index"];
	        this.NodeID = source["NodeID"];
	        this.MissionName = source["MissionName"];
	        this.StartKind = source["StartKind"];
	        this.StartLine = source["StartLine"];
	        this.EndLine = source["EndLine"];
	        this.StartTime = source["StartTime"];
	        this.EndTime = source["EndTime"];
	        this.DurationSec = source["DurationSec"];
	        this.StateStartedTime = source["StateStartedTime"];
	        this.StateEndingTime = source["StateEndingTime"];
	        this.StateDurationSec = source["StateDurationSec"];
	        this.SpawnedAtEnd = source["SpawnedAtEnd"];
	        this.FirstOnAgentCreatedTime = source["FirstOnAgentCreatedTime"];
	        this.LastOnAgentCreatedTime = source["LastOnAgentCreatedTime"];
	        this.OnAgentCreatedSpanSec = source["OnAgentCreatedSpanSec"];
	        this.ShieldDronePerMin = source["ShieldDronePerMin"];
	        this.ShieldDroneCount = source["ShieldDroneCount"];
	        this.Status = source["Status"];
	        this.Note = source["Note"];
	        this.NodeInfo = this.convertValues(source["NodeInfo"], NodeInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class ParseResult {
	    Missions: MissionResult[];
	    Warnings: string[];
	
	    static createFrom(source: any = {}) {
	        return new ParseResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Missions = this.convertValues(source["Missions"], MissionResult);
	        this.Warnings = source["Warnings"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

