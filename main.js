const iconv = require('iconv-lite');

module.exports.templateTags = [{
    name: 'responseRegex',
    displayName: 'Response regex',
    description: "extract values from other request's responses based on a regex",
    args: [
		{
        	displayName: 'Request',
        	type: 'model',
        	model: 'Request',
        },
        {
            displayName: 'Regex',
            help: 'The result of the first capture group is returned',
            type: 'string'
        },
        {
        	displayName: 'Trigger Behavior',
        	help: 'Configure when to resend the dependent request',
        	type: 'enum',
        	defaultValue: 'never',
        	options: [
        		{
        			displayName: 'Never',
        			description: 'never resend request',
        			value: 'never',
        		},
	            {
	            	displayName: 'No History',
	            	description: 'resend when no responses present',
	            	value: 'no-history',
	            },
	            {
	            	displayName: 'When Expired',
	            	description: 'resend when existing response has expired',
	            	value: 'when-expired',
	            },
	            {
	            	displayName: 'Always',
	            	description: 'resend request when needed',
	            	value: 'always',
	            },
        	],
        },
        {
        	displayName: 'Max age (seconds)',
        	help: 'The maximum age of a response to use before it expires',
        	type: 'number',
        	hide: args => {
        		const triggerBehavior = (args[3] && args[3].value) || 'never';
        		return triggerBehavior !== 'when-expired';
        	},
        	defaultValue: 60,
        },
    ],
    async run(context, id, regex = '', resendBehavior, maxAgeSeconds) {
        // Build the regex right away to throw early if the regex is invalid
        var regExp = new RegExp(regex, "gm")

        if (!id) {
          throw new Error('No request specified');
        }

        const request = await context.util.models.request.getById(id);
        if (!request) {
          throw new Error(`Could not find request ${id}`);
        }

        if (!/(?<!\\)\(.*(?<!\\)\)/.test(regex)) {
            throw new Error('The regex must specify at least one capture group');
        }

        const environmentId = context.context.getEnvironmentId?.();
        let response = await context.util.models.response.getLatestForRequestId(id, environmentId);

        let shouldResend = false;
        switch (resendBehavior) {
          case 'no-history':
            shouldResend = !response;
            break;

          case 'when-expired':
            if (!response) {
              shouldResend = true;
            } else {
              const ageSeconds = (Date.now() - response.created) / 1000;
              shouldResend = ageSeconds > maxAgeSeconds;
            }
            break;

          case 'always':
            shouldResend = true;
            break;

          case 'never':
          default:
            shouldResend = false;
            break;

        }

        // Make sure we only send the request once per render so we don't have infinite recursion
        const requestChain = context.context.getExtraInfo?.('requestChain') || [];
        if (requestChain.some((id) => id === request._id)) {
          console.log('[response-body-regex] Preventing recursive render');
          shouldResend = false;
        }

        if (shouldResend && context.renderPurpose === 'send') {
          console.log('[response-body-regex] Resending dependency');
          requestChain.push(request._id);
          response = await context.network.sendRequest(request, [
            { name: 'requestChain', value: requestChain },
          ]);
        }

        if (!response) {
          console.log('[response-body-regex] No response found');
          throw new Error('No responses for request');
        }

        if (response.error) {
          console.log('[response-body-regex] Response error ' + response.error);
          throw new Error('Failed to send dependent request ' + response.error);
        }

        if (!response.statusCode) {
          console.log('[response-body-regex] Invalid status code ' + response.statusCode);
          throw new Error('No successful responses for request');
        }

        const bodyBuffer = context.util.models.response.getBodyBuffer(response, '');
        const match = response.contentType && response.contentType.match(/charset=([\w-]+)/);
        const charset = match && match.length >= 2 ? match[1] : 'utf-8';

        let body;
        try {
            body = iconv.decode(bodyBuffer, charset);
        } catch (err) {
            // Sometimes iconv conversion fails so fallback to regular buffer
            console.warn('[response-body-regex] Failed to decode body', err);
            body = bodyBuffer.toString();
        }

        var res = regExp.exec(body);

        if (!res || res.length < 2) {
            throw new Error("The provided regex didn't match the response's body");
        }

        return res[1];
    }
}];