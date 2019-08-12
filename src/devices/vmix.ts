import * as _ from 'underscore'
import {
	DeviceWithState,
	CommandWithContext,
	DeviceStatus,
	StatusCode
} from './device'
import {
	DeviceType,
	DeviceOptions,
	VMixOptions,
	VMixCommandContent
} from '../types/src'
import { DoOnTime, SendMode } from '../doOnTime'
// import * as request from 'request'

import {
	TimelineState
} from 'superfly-timeline'
import { VMix } from './vmixAPI'
import {
	MappingVMix,
	TimelineContentTypeVMix,
	TimelineObjVMixInput,
	VMixCommand,
	VMixTransitionType,
	TimelineObjVMixPreview,
	TimelineObjVMixAudio,
	TimelineObjVMixFader,
	TimelineObjVMixAddInput,
	TimelineObjVMixPlayInput,
	TimelineObjVMixPauseInput,
	TimelineObjVMixRestartInput,
	TimelineObjVMixSetPosition,
	TimelineObjVMixSetInputName
} from '../types/src/vmix'

export interface VMixStateCommand {
	command: VMixCommand
	context: CommandContext
	input?: string | number
	value?: string | number
	timelineId: string
}

export interface VMixDeviceOptions extends DeviceOptions {
	options?: {
		commandReceiver?: CommandReceiver
	}
}
export type CommandReceiver = (time: number, cmd: VMixStateCommand, context: CommandContext, timelineObjId: string) => Promise<any>
/*interface Command {
	commandName: 'added' | 'changed' | 'removed'
	content: VMixCommandContent
	context: CommandContext
	timelineObjId: string
	layer: string
}*/
type CommandContext = any

/**
 * This is a VMixDevice, it sends commands when it feels like it
 */
export class VMixDevice extends DeviceWithState<VMixState> {

	private _makeReadyCommands: VMixCommandContent[]
	private _doOnTime: DoOnTime

	private _commandReceiver: CommandReceiver
	private _vmix: VMix
	private _connected: boolean = false
	private _initialized: boolean = false

	constructor (deviceId: string, deviceOptions: VMixDeviceOptions, options) {
		super(deviceId, deviceOptions, options)
		console.log(this._connected)
		if (deviceOptions.options) {
			if (deviceOptions.options.commandReceiver) this._commandReceiver = deviceOptions.options.commandReceiver
			else this._commandReceiver = this._defaultCommandReceiver
		}
		this._doOnTime = new DoOnTime(() => {
			return this.getCurrentTime()
		}, SendMode.IN_ORDER, this._deviceOptions)
		this._doOnTime.on('error', e => this.emit('error', 'VMix.doOnTime', e))
		this._doOnTime.on('slowCommand', msg => this.emit('slowCommand', this.deviceName + ': ' + msg))
	}
	init (options: VMixOptions): Promise<boolean> {
		return new Promise((resolve, reject) => {
			this._makeReadyCommands = options.makeReadyCommands || []

			this._vmix = new VMix()
			this._vmix.once('connected', () => {
				this._connected = true
				this._initialized = true
				this._connectionChanged()
				resolve(true)
			})
			this._vmix.on('connected', () => {
				let time = this.getCurrentTime()
				this.setState(this._vmix.state, time)
				this._connected = true
				this._initialized = true
				this._connectionChanged()
				this.emit('resetResolver')
			})
			this._vmix.on('disconnected', () => {
				this._connected = false
				this._connectionChanged()
			})
			this._vmix.on('error', (e) => this.emit('error', 'VMix', e))
			this._vmix.on('stateChanged', (state) => this._onVMixStateChanged(state))

			this._vmix.connect(options)
			.catch(e => {
				reject(e)
			})
		})
	}
	private _connectionChanged () {
		this.emit('connectionChanged', this.getStatus())
	}

	private _onVMixStateChanged (newState: VMixState) {
		this.setState(newState, Date.now())
	}

	private _getDefaultState (): VMixState {
		return {
			version: '22.0.0.67',
			edition: 'Trial',
			inputs: [],
			overlays: [],
			preview: undefined,
			active: undefined,
			fadeToBlack: false,
			faderPosition: undefined,
			transitions: [],
			recording: false,
			external: false,
			streaming: false,
			playlist: false,
			multiCorder: false,
			fullscreen: false,
			audio: []
		}
	}

	handleState (newState: TimelineState) {
		if (!this._initialized) { // before it's initialized don't do anything
			this.emit('info', 'VMix not initialized yet')
			return
		}

		let previousStateTime = Math.max(this.getCurrentTime(), newState.time)
		let oldState: VMixState = (this.getStateBefore(previousStateTime) || { state: this._getDefaultState() }).state

		let newAbstractState = this.convertStateToVMix(newState, oldState)

		let commandsToAchieveState: Array<any> = this._diffStates(oldState, newAbstractState)

		// clear any queued commands later than this time:
		this._doOnTime.clearQueueNowAndAfter(previousStateTime)

		// add the new commands to the queue:
		this._addToQueue(commandsToAchieveState, newState.time)

		// store the new state, for later use:
		this.setState(newAbstractState, newState.time)
	}
	clearFuture (clearAfterTime: number) {
		// Clear any scheduled commands after this time
		this._doOnTime.clearQueueAfter(clearAfterTime)
	}
	terminate () {
		this._doOnTime.dispose()
		return Promise.resolve(true)
	}
	getStatus (): DeviceStatus {
		// Good, since this device has no status, really
		return {
			statusCode: StatusCode.GOOD
		}
	}
	async makeReady (okToDestroyStuff?: boolean): Promise<void> {
		if (okToDestroyStuff && this._makeReadyCommands && this._makeReadyCommands.length > 0) {
			_.each(this._makeReadyCommands, (cmd: VMixCommandContent) => {
				console.log(cmd)
				// add the new commands to the queue:
				/*this._doOnTime.queue(time, cmd.queueId, (cmd: VMixCommandContent) => {
					return this._commandReceiver(time, cmd, 'makeReady', '')
				}, cmd)*/
			})
		}
	}

	get canConnect (): boolean {
		return false
	}
	get connected (): boolean {
		return false
	}
	convertStateToVMix (state: TimelineState, oldState: VMixState): VMixState {
		if (!this._initialized) throw Error('convertStateToVMix cannot be used before inititialized')

		let deviceState = JSON.parse(JSON.stringify(oldState))

		// Sort layer based on Layer name
		const sortedLayers = _.map(state.layers, (tlObject, layerName) => ({ layerName, tlObject }))
			.sort((a,b) => a.layerName.localeCompare(b.layerName))

		_.each(sortedLayers, ({ tlObject, layerName }) => {
			let mapping = this.getMapping()[layerName] as MappingVMix

			console.log(mapping) // TODO: Use this later

			if (tlObject.content) {
				deviceState.momentary = []
				switch (tlObject.content.type) {
					case TimelineContentTypeVMix.INPUT:
						let vmixTlInput = tlObject as any as TimelineObjVMixInput
						if (vmixTlInput.content.input) {
							let available = deviceState.inputs.filter(input =>
								input.number === Number(vmixTlInput.content.input) ||
								input.key === vmixTlInput.content.input
							).length !== 0
							if (available) deviceState.active = vmixTlInput.content.input
							deviceState.active = vmixTlInput.content.input
						}
						if (vmixTlInput.content.transition) {
							deviceState.transitions = [] // TODO: Preserve transitions
							deviceState.transitions.push({
								effect: vmixTlInput.content.transition.type,
								duration: vmixTlInput.content.transition.duration,
								number: vmixTlInput.content.transition.button
							})
						}
						break
					case TimelineContentTypeVMix.PREVIEW:
						let vmixTlPreview = tlObject as any as TimelineObjVMixPreview
						if (vmixTlPreview.content.input) deviceState.preview = vmixTlPreview.content.input
						break
					case TimelineContentTypeVMix.AUDIO:
						let vmixTlAudio = tlObject as any as TimelineObjVMixAudio
						deviceState.inputs = this.modifyInput(deviceState.inputs, {
							number: Number(vmixTlAudio.content.input),
							volume: vmixTlAudio.content.volume
						})
						break
					case TimelineContentTypeVMix.FADER:
						let vmixTlFader = tlObject as any as TimelineObjVMixFader
						deviceState.faderPosition = vmixTlFader.content.position
						break
					case TimelineContentTypeVMix.START_RECORDING:
						deviceState.recording = true
						break
					case TimelineContentTypeVMix.STOP_RECORDING:
						deviceState.recording = false
						break
					case TimelineContentTypeVMix.START_STREAMING:
						deviceState.streaming = true
						break
					case TimelineContentTypeVMix.STOP_STREAMING:
						deviceState.streaming = false
						break
					case TimelineContentTypeVMix.FADE_TO_BLACK:
						deviceState.fadeToBlack = true
						break
					case TimelineContentTypeVMix.ADD_INPUT:
						let tlObjectAddInput = tlObject as any as TimelineObjVMixAddInput
						let exists = deviceState.inputs.filter(input =>
							input.title &&
							tlObjectAddInput.content.filePath.indexOf(input.title) !== -1 &&
							input.type &&
							input.type === tlObjectAddInput.content.mediaType
						).length !== 0
						if (!exists) deviceState.momentary.push(tlObject as any as TimelineObjVMixAddInput)
						break
					case TimelineContentTypeVMix.PLAY_INPUT:
						let tlObjectPlayInput = tlObject as any as TimelineObjVMixPlayInput
						deviceState.inputs = this.modifyInput(deviceState.inputs, {
							number: Number(tlObjectPlayInput.content.input),
							state: 'Running'
						})
						break
					case TimelineContentTypeVMix.PAUSE_INPUT:
						let tlObjectPauseInput = tlObject as any as TimelineObjVMixPauseInput
						deviceState.inputs = this.modifyInput(deviceState.inputs, {
							number: Number(tlObjectPauseInput.content.input),
							state: 'Paused'
						})
						break
					case TimelineContentTypeVMix.RESTART_INPUT:
						let tlObjectRestartInput = tlObject as any as TimelineObjVMixRestartInput
						deviceState.inputs = this.modifyInput(deviceState.inputs, {
							number: Number(tlObjectRestartInput.content.input),
							position: 0
						})
						break
					case TimelineContentTypeVMix.SET_POSITION:
						let tlObjSetPosition = tlObject as any as TimelineObjVMixSetPosition
						deviceState.inputs = this.modifyInput(deviceState.inputs, {
							number: Number(tlObjSetPosition.content.input),
							position: tlObjSetPosition.content.position
						})
						break
					case TimelineContentTypeVMix.SET_INPUT_NAME:
						let tlObjSetInputName = tlObject as any as TimelineObjVMixSetInputName
						deviceState.inputs = this.modifyInput(deviceState.inputs, {
							number: Number(tlObjSetInputName.content.input),
							name: tlObjSetInputName.content.name
						})
						break
				}
			}
		})
		return deviceState
	}
	modifyInput (inputs: VMixInput[], newInput: VMixInput): VMixInput[] {
		let index = inputs.findIndex(input => input.number === newInput.number)

		if (index !== -1) {
			inputs[index] = { ...inputs[index], ...newInput }
		} else {
			inputs.push(newInput)
		}

		return inputs
	}
	get deviceType () {
		return DeviceType.VMIX
	}
	get deviceName (): string {
		return 'VMix-Send ' + this.deviceId
	}
	get queue () {
		return this._doOnTime.getQueue()
	}
	private _addToQueue (commandsToAchieveState: Array<VMixStateCommand>, time: number) {
		_.each(commandsToAchieveState, (cmd: VMixStateCommand) => {

			// add the new commands to the queue:
			this._doOnTime.queue(time, undefined, (cmd: VMixStateCommand) => {
				return this._commandReceiver(time, cmd, cmd.context, cmd.timelineId)
			}, cmd)
		})
	}
	private _diffStates (oldVMixState: VMixState, newVMixState: VMixState): Array<VMixStateCommand> {
		let commands: Array<VMixStateCommand> = []

		if (newVMixState.active !== undefined) {
			if (!_.isEqual(oldVMixState.transitions, newVMixState.transitions)) {
				_.difference(newVMixState.transitions, oldVMixState.transitions)
				.forEach(transition => {
					if (oldVMixState.active !== newVMixState.active) {
						commands.push({
							command: VMixCommand.PREVIEW_INPUT,
							input: newVMixState.active ? newVMixState.active : '1',
							context: null,
							timelineId: ''
						})
						newVMixState.fadeToBlack = false
					}

					commands.push({
						command: VMixCommand.TRANSITION_EFFECT,
						value: transition.effect,
						input: transition.number,
						context: null,
						timelineId: ''
					})

					commands.push({
						command: VMixCommand.TRANSITION_DURATION,
						value: transition.duration,
						input: transition.number,
						context: null,
						timelineId: ''
					})

					if (oldVMixState.active !== newVMixState.active) {
						commands.push({
							command: VMixCommand.TRANSITION,
							input: transition.number,
							context: null,
							timelineId: ''
						})
					}
				})
			} else {
				if (oldVMixState.active !== newVMixState.active) {
					commands.push({
						command: VMixCommand.ACTIVE_INPUT,
						input: newVMixState.active,
						context: null,
						timelineId: ''
					})
					newVMixState.fadeToBlack = false
				}
			}
		}

		if (newVMixState.preview !== undefined) {
			if (oldVMixState.preview !== newVMixState.preview) {
				commands.push({
					command: VMixCommand.PREVIEW_INPUT,
					input: newVMixState.preview,
					context: null,
					timelineId: ''
				})
				newVMixState.fadeToBlack = false
			}
		}

		if (!_.isEqual(oldVMixState.inputs, newVMixState.inputs)) {
			_.difference(newVMixState.inputs, oldVMixState.inputs)
			.forEach(input => {
				if (input.number) {
					let oldInput = oldVMixState.inputs.filter(inp => inp.number === input.number)[0]
					if (oldInput) {
						if (oldInput.position !== input.position) {
							commands.push({
								command: VMixCommand.SET_POSITION,
								input: input.number,
								value: input.position,
								context: null,
								timelineId: ''
							})
						}

						if (oldInput.state !== input.state) {
							if (input.state === 'Running') {
								commands.push({
									command: VMixCommand.PLAY_INPUT,
									input: input.number,
									context: null,
									timelineId: ''
								})
							} else if (input.state === 'Paused') {
								commands.push({
									command: VMixCommand.PAUSE_INPUT,
									input: input.number,
									context: null,
									timelineId: ''
								})
							}
						}

						if (oldInput.volume !== input.volume) {
							commands.push({
								command: VMixCommand.AUDIO,
								input: input.number.toString(),
								value: input.volume,
								context: null,
								timelineId: ''
							})
						}

						if (oldInput.name !== input.name) {
							commands.push({
								command: VMixCommand.SET_INPUT_NAME,
								input: input.number.toString(),
								value: input.name,
								context: null,
								timelineId: ''
							})
						}
					}
				}
			})
		}

		// Only set fader bar position if no other transitions are happening
		if (newVMixState.preview === undefined && newVMixState.active === undefined) {
			if (newVMixState.faderPosition !== undefined) {
				commands.push({
					command: VMixCommand.FADER,
					value: newVMixState.faderPosition,
					context: null,
					timelineId: ''
				})
				newVMixState.active = undefined
				newVMixState.preview = undefined
				newVMixState.fadeToBlack = false
			}
		}

		if (oldVMixState.recording !== newVMixState.recording) {
			if (newVMixState.recording) {
				commands.push({
					command: VMixCommand.START_RECORDING,
					context: null,
					timelineId: ''
				})
			} else {
				commands.push({
					command: VMixCommand.STOP_RECORDING,
					context: null,
					timelineId: ''
				})
			}
		}

		if (oldVMixState.streaming !== newVMixState.streaming) {
			if (newVMixState.streaming) {
				commands.push({
					command: VMixCommand.START_STREAMING,
					context: null,
					timelineId: ''
				})
			} else {
				commands.push({
					command: VMixCommand.STOP_STREAMING,
					context: null,
					timelineId: ''
				})
			}
		}

		if (oldVMixState.fadeToBlack !== newVMixState.fadeToBlack) {
			if (newVMixState.fadeToBlack) {
				commands.push({
					command: VMixCommand.FADE_TO_BLACK,
					context: null,
					timelineId: ''
				})
			}
		}

		if (newVMixState.momentary) {
			newVMixState.momentary.forEach(command => {
				switch (command.content.type) {
					case TimelineContentTypeVMix.ADD_INPUT:
						commands.push({
							command: VMixCommand.ADD_INPUT,
							value: `${command.content.mediaType}|${command.content.filePath}`,
							context: null,
							timelineId: ''
						})
						break
				}
			})
		}

		return commands
	}
	private _defaultCommandReceiver (time: number, cmd: VMixStateCommand, context: CommandContext, timelineObjId: string): Promise<any> {
		time = time

		let cwc: CommandWithContext = {
			context: context,
			command: cmd,
			timelineObjId: timelineObjId
		}
		this.emit('debug', cwc)

		return this._vmix.sendCommand(cwc.command)
		.catch(error => {
			this.emit('commandError', error, cwc)
		})
	}
}

export class VMixState {
	version: string
	edition: string // TODO: Enuum, need list of available editions: Trial
	inputs: VMixInput[]
	overlays: VMixOverlays[]
	preview: string | undefined
	active: string | undefined
	fadeToBlack: boolean
	faderPosition?: number
	transitions: VMixTransition[]
	recording: boolean
	external: boolean
	streaming: boolean
	playlist: boolean
	multiCorder: boolean
	fullscreen: boolean
	audio: VMixAudioChannel[]
	momentary?: VMixMomentaryCommands[]
}

export interface VMixInput {
	key?: string
	number?: number
	type?: VMixInputType
	title?: string
	name?: string
	state?: 'Paused' | 'Running' | 'Completed',
	position?: number
	duration?: number
	loop?: boolean
	muted?: boolean
	volume?: number // 0 - 100
	balance?: number
	solo?: boolean
	audiobusses?: string
	meterF1?: number
	meterF2?: number
	content?: string
}

export interface VMixOverlays {
	number: string
	key: string
}

export interface VMixTransition {
	number: 1 | 2 | 3 | 4
	effect: VMixTransitionType
	duration: number
}

export interface VMixAudioChannel {
	volume: number
	muted: Boolean
	meterF1: number
	meterF2: number
	headphonesVolume: number
}

type VMixMomentaryCommands = TimelineObjVMixAddInput
export type VMixInputType = 'Video' | 'Image' | 'Photos' | 'Xaml' | 'VideoList' | 'Colour' | 'AudioFile' | 'Flash' | 'PowerPoint'
