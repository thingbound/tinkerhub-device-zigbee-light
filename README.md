# Zigbee Light support for Tinkerhub

This module contains experimental support for turning lights found in a Zigbee
network into Tinkerhub lights.

This module requires that you have [tinkerhub-bridge-zigbee](https://github.com/tinkerhub/tinkerhub-bridge-zigbee)
installed and running somewhere in your network as this will only extend any
Zigbee device seen that is defined to be a light.

Any Zigbee-compatible light including should be supported, such as Philips Hue,
OSRAM Lightify and IKEA Trådfri. Devices will be tested for Zigbee Light Link
support and will announce their capabilities correctly. Turning lights on and
off, setting their brightness and color is currently supported.

For now this has been tested with an IKEA Trådfri light that supports color
temperature and not full Hue/Saturation colors.
