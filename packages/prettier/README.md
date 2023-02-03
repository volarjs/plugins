# @volar-plugins/prettier

Volar plugin for [prettier](https://prettier.io/).

## Usage

`package.json`

```json
{
  "devDependencies": {
    "@volar-plugins/prettier": "latest"
  }
}
```

`volar.config.js`

```js
module.exports = {
	plugins: [
		require('@volar-plugins/prettier')(
			{
				languages: ['html', 'css', 'scss', 'typescript', 'javascript'],
				html: {
					breakContentsFromTags: true,
				},
				ignoreIDEOptions: true,
			},
			// provide your prettier options, otherwise auto resolve config file by plugin
			() => ({
				// ...
			})
		),
	],
};
```
