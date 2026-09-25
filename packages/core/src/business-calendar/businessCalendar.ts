import {ValidationError} from "../domain/errors"
import {snapshotData} from "../kernel/snapshotData"

export interface BusinessCalendarRequest {readonly calendarKey:string;readonly timeZone:string}
export interface WorkingWindow {readonly start:Date;readonly end:Date}
export interface BusinessCalendarPort {isBusinessDay(date:Date,request:BusinessCalendarRequest):Promise<boolean>;nextBusinessDay(date:Date,request:BusinessCalendarRequest):Promise<Date>;workingWindows(from:Date,to:Date,request:BusinessCalendarRequest):Promise<readonly WorkingWindow[]>}
export function validateWorkingWindows(from:Date,to:Date,windows:readonly WorkingWindow[]):readonly WorkingWindow[]{
  if(!(from instanceof Date)||!(to instanceof Date)||!Array.isArray(windows)||Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||from>=to) throw new ValidationError("Business-calendar range must be valid and increasing.")
  let prior=from.getTime();for(const window of windows){if(!window||typeof window!=="object"||!(window.start instanceof Date)||!(window.end instanceof Date)||Number.isNaN(window.start.getTime())||Number.isNaN(window.end.getTime())||window.start>=window.end||window.start<from||window.end>to||window.start.getTime()<prior) throw new ValidationError("Business-calendar windows must be ordered, non-overlapping and within range.");prior=window.end.getTime()}return snapshotData(windows,{label:"Business-calendar windows"})
}
