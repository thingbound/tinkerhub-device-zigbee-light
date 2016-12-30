'use strict';

const th = require('tinkerhub');

const deepEqual = require('deep-equal');
const clone = require('clone');

th.devices.extend([ 'type:zigbee' ], function(encounter) {
    encounter.device.zigbeeInspect()
        .then(data => {
            data.endpoints.forEach(ep => {
                switch(ep.deviceId) {
                    case 256:
                    case 257:
                    case 258:
                        {
                            const light = new Light(encounter.device, ep);
                            light._device = encounter.enhance(light);
                        }
                        break;
                }
            })
        })
        .done();
});

// Default transition time, set to 400 ms which is the as the Hue API uses
const DURATION = th.values.duration(400);

function toTenthOfSecond(d) {
    return Math.floor(d.ms / 100);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function extend(light, cap, def) {
    light.metadata.capabilities.push(cap);
    Object.keys(def).forEach(d => light[d] = def[d]);
}

class Light {
    constructor(zigbee, endpoint) {
        this._zigbee = zigbee;
        this._endpoint = endpoint.id;

        this.metadata = {
            type: [ 'light' ],
            capabilities: []
        };

        this.state = {
            power: endpoint.clusters.genOnOff.attributes.onOff == 1
        };

        if(endpoint.clusters.genLevelCtrl) {
            this.metadata.capabilities.push('dimmable');

            this.state.brightness = endpoint.clusters.genLevelCtrl.attributes.currentLevel;

            extend(this, 'dimmable', {
                brightness(brightness, duration) {
                    if(brightness) {
                        let toSet;
                        if(brightness.isIncrease) {
                            toSet = this.state.brightness + brightness.value;
                        } else if(brightness.isDecrease) {
                            toSet = this.state.brightness - brightness.value;
                        } else {
                            toSet = brightness.value;
                        }
                        return this.setBrightness(toSet, duration);
                    }

                    return this.state.brightness;
                },

                setBrightness(brightness, duration) {
                    duration = duration || DURATION;
                    brightness = clamp(brightness, 0, 100);

                    return this._zigbee.zigbeeFunctional(this._endpoint, 'genLevelCtrl', 'moveToLevel', {
                        level: clamp(brightness / 100 * 255, 0, 254),
                        transtime: toTenthOfSecond(duration)
                    })
                    .then(this._switchState(state => state.brightness = brightness))
                    .then(() => brightness);
                },

                increaseBrightness(brightness, duration) {
                    return this.setBrightness(Math.min(100, this.state.brightness + brightness), duration);
                },

                decreaseBrightness(brightness, duration) {
                    return this.setBrightness(Math.max(0, this.state.brightness - brightness), duration);
                }
            })
        }

        if(endpoint.clusters.lightingColorCtrl) {
            const color = endpoint.clusters.lightingColorCtrl;
            const colorCaps = color.colorCapabilities;

            /*
             * Use a combination of the capabilities that the light says it has
             * to make a guess about what it actually supports.
             *
             * colorCapabilities is a bitset with these values:
             *   const COLOUR_CAPABILITY_HUE_SATURATION_SUPPORTED = (1 << 0);
             *   const COLOUR_CAPABILITY_ENHANCE_HUE_SUPPORTED = (1 << 1);
             *   const COLOUR_CAPABILITY_COLOUR_LOOP_SUPPORTED = (1 << 2);
             *   const COLOUR_CAPABILITY_XY_SUPPORTED = (1 << 3);
             *   const COLOUR_CAPABILITY_COLOUR_TEMPERATURE_SUPPORTED = (1 << 4);
             *
             */

            // If the light says it supports temperature or if it has set a physical range
            this._supportsTemperature = (colorCaps & 16) != 0
                || typeof color.attributes.colorTempPhysicalMin !== 'undefined';

            // If the light says it supports XY and actually has primaries that can be set
            this._supportsXY = ((colorCaps & 8) != 0 || typeof color.attributes.currentX !== 'undefined') && color.attributes.numPrimaries > 0;

            // If the light says it supports Hue and Sat
            this._supportsHue = (colorCaps & 1) != 0 || (colorCaps & 2) != 0;
            this._supportsEnhancedHue = (colorCaps & 2);

            // Fetch the temperature limits or fallback to those used by Philips Hue
            this._temperatureLimits = [ color.attributes.colorTempPhysicalMin || 154, color.attributes.colorTempPhysicalMax || 500 ];

            if(this._supportsTemperature || this._supportsXY || this._supportsHue) {
                extend(this, 'color', {
                    color(color, duration) {
                        if(color) {
                            return this.setColor(color, duration);
                        }

                        return this.state.color;
                    },

                    setColor(color, duration) {
                        duration = duration || DURATION;

                        if(! color) throw new Error('Color is required');

                        // Figure out best way to change color
                        if(color.is('temperature')) {
                            if(! this._supportsTemperature) {
                                if(this._supportsXY) {
                                    color = color.xyY;
                                } else {
                                    color = color.hsl;
                                }
                            }
                        } else {
                            if(this._supportsXY) {
                                color = color.xyY;
                            } else if(this._supportsHue) {
                                color = color.hsl;
                            } else if(this._supportsTemperature) {
                                color = color.temperature;
                            } else {
                                throw new Error('This light does not support any known color mode');
                            }
                        }

                        let promise = null;
                        if(color.is('temperature')) {
                            let mired = clamp(
                                color.mired.value,
                                this._temperatureLimits[0],
                                this._temperatureLimits[1]
                            );

                            color = th.values.color.mired(mired).temperature;

                            promise = this._zigbee.zigbeeFunctional(
                                this._endpoint,
                                'lightingColorCtrl',
                                'moveToColorTemp',
                                {
                                    colortemp: mired,
                                    transtime: toTenthOfSecond(duration)
                                }
                            );
                        } else if(color.is('xyY')) {
                            promise = this._zigbee.zigbeeFunctional(
                                this._endpoint,
                                'lightingColorCtrl',
                                'moveToColor',
                                {
                                    colorx: color.x * 65536,
                                    colory: color.y * 65536,
                                    transtime: toTenthOfSecond(duration)
                                }
                            );
                        } else if(this._supportsEnhancedHue) {
                            promise = this._zigbee.zigbeeFunctional(
                                this._endpoint,
                                'lightingColorCtrl',
                                'enhancedMoveToHueAndSaturation',
                                {
                                    enhancehue: color.hue / 360 * 65536,
                                    saturation: color.saturation / 100 * 255,
                                    transtime: toTenthOfSecond(duration)
                                }
                            );
                        } else {
                            promise = this._zigbee.zigbeeFunctional(
                                this._endpoint,
                                'lightingColorCtrl',
                                'moveToHueAndSaturation',
                                {
                                    hue: color.hue / 360 * 255,
                                    saturation: color.saturation / 100 * 255,
                                    transtime: toTenthOfSecond(duration)
                                }
                            );
                        }

                        return promise
                            .then(this._switchState(state => state.color = color))
                            .then(() => color);
                    }
                });

                if(this._supportsTemperature) {
                    this.metadata.capabilities.push('color:temperature');
                }

                if(this._supportsXY || this._supportsHue) {
                    this.metadata.capabilities.push('color:full');
                }
            }
        }

        zigbee.on('zigbee:value', data => {
            if(data.endpoint != this.endpoint) return;

            if(data.cluster === 'genOnOff' && data.attribute === 'onOff') {
                this._switchState(state => state.power = data.newValue === 1);
            } else if(data.cluster === 'genLevelCtrl' && data.attribute === 'currentLevel') {
                this._switchState(state => state.brightness = Math.round(data.newValue / 255 * 100));
            }
        });
    }

    power(on) {
        if(typeof on !== 'undefined') {
            return this.setPower(on);
        }
        return this.state.power;
    }

    setPower(on) {
        return this._zigbee.zigbeeFunctional(this._endpoint, 'genOnOff', on ? 'on' : 'off', {})
            .then(this._switchState(state => state.power = on))
            .then(() => on);
    }

    turnOn() {
        return this.setPower(true);
    }

    turnOff() {
        return this.setPower(false);
    }

    _setState(state) {
        if(! deepEqual(this.state, state)) {
            this._device.emit('state', state);

            if(this.state.power !== state.power) {
                this._device.emit('power', state.power);
            }

            if(this.state.brightness !== state.brightness) {
                this._device.emit('light:brightness', state.brightness);
            }

            if(! deepEqual(this.state.color, state.color)) {
                this._device.emit('light:color', state.color);
            }

            this.state = state;
        }
    }

    _switchState(func) {
        return () => {
            const state = clone(this.state);
            func(state);
            this._setState(state);

            return state;
        };
    }

}
