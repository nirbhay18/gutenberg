/**
 * External dependencies
 */
import { parse as hpqParse } from 'hpq';
import { mapValues, reduce, pickBy } from 'lodash';

/**
 * WordPress dependencies
 */
import { bumpStat } from '@wordpress/utils';

/**
 * Internal dependencies
 */
import { parse as grammarParse } from './post.pegjs';
import { getBlockType, getUnknownTypeHandlerName } from './registration';
import { createBlock } from './factory';
import { isValidBlock } from './validation';

/**
 * Returns true if the provided function is a valid attribute source, or false
 * otherwise.
 *
 * Sources are implemented as functions receiving a DOM node to select data
 * from. Using the DOM is incidental and we shouldn't guarantee a contract that
 * this be provided, else block implementers may feel inclined to use the node.
 * Instead, sources are intended as a generic interface to query data from any
 * tree shape. Here we pick only sources which include an internal flag.
 *
 * @param  {Function} source Function to test
 * @return {Boolean}         Whether function is an attribute source
 */
export function isValidSource( source ) {
	return !! source && '_wpBlocksKnownMatcher' in source;
}

/**
 * Returns the block attributes parsed from raw content.
 *
 * @param  {String} rawContent Raw block content
 * @param  {Object} schema     Block attribute schema
 * @return {Object}            Block attribute values
 */
export function getSourcedAttributes( rawContent, schema ) {
	const sources = mapValues(
		// Parse only sources with source defined
		pickBy( schema, ( attributeSchema ) => isValidSource( attributeSchema.source ) ),

		// Transform to object where source is value
		( attributeSchema ) => attributeSchema.source
	);

	return hpqParse( rawContent, sources );
}

/**
 * Returns the block attributes of a registered block node given its type.
 *
 * @param  {?Object} blockType     Block type
 * @param  {string}  rawContent    Raw block content
 * @param  {?Object} attributes    Known block attributes (from delimiters)
 * @return {Object}                All block attributes
 */
export function getBlockAttributes( blockType, rawContent, attributes ) {
	// Merge source values into attributes parsed from comment delimiters
	attributes = {
		...attributes,
		...getSourcedAttributes( rawContent, blockType.attributes ),
	};

	return reduce( blockType.attributes, ( result, source, key ) => {
		let value = attributes[ key ];

		// Return default if attribute value not assigned
		if ( undefined === value ) {
			// Nest the condition so that constructor coercion never occurs if
			// value is undefined and block type doesn't specify default value
			if ( 'default' in source ) {
				value = source.default;
			} else {
				return result;
			}
		}

		// Coerce to constructor value if source type
		switch ( source.type ) {
			case 'string':
				value = String( value );
				break;

			case 'boolean':
				value = Boolean( value );
				break;

			case 'object':
				value = Object( value );
				break;

			case 'null':
				value = null;
				break;

			case 'array':
				value = Array.from( value );
				break;

			case 'integer':
			case 'number':
				value = Number( value );
				break;
		}

		result[ key ] = value;
		return result;
	}, {} );
}

/**
 * Creates a block with fallback to the unknown type handler.
 *
 * @param  {?String} name       Block type name
 * @param  {String}  rawContent Raw block content
 * @param  {?Object} attributes Attributes obtained from block delimiters
 * @return {?Object}            An initialized block object (if possible)
 */
export function createBlockWithFallback( name, rawContent, attributes ) {
	// Use type from block content, otherwise find unknown handler.
	name = name || getUnknownTypeHandlerName();

	// Convert 'core/text' blocks in existing content to the new
	// 'core/paragraph'.
	if ( name === 'core/text' ) {
		bumpStat( 'block_auto_convert', 'core-text-to-paragraph' );
		name = 'core/paragraph';
	}

	// Try finding type for known block name, else fall back again.
	let blockType = getBlockType( name );
	const fallbackBlock = getUnknownTypeHandlerName();
	if ( ! blockType ) {
		name = fallbackBlock;
		blockType = getBlockType( name );
	}

	// Include in set only if type were determined.
	// TODO do we ever expect there to not be an unknown type handler?
	if ( blockType && ( rawContent || name !== fallbackBlock ) ) {
		// TODO allow blocks to opt-in to receiving a tree instead of a string.
		// Gradually convert all blocks to this new format, then remove the
		// string serialization.
		const block = createBlock(
			name,
			getBlockAttributes( blockType, rawContent, attributes )
		);

		// Validate that the parsed block is valid, meaning that if we were to
		// reserialize it given the assumed attributes, the markup matches the
		// original value. Otherwise, preserve original to avoid destruction.
		block.isValid = isValidBlock( rawContent, blockType, block.attributes );
		if ( ! block.isValid ) {
			block.originalContent = rawContent;
		}

		return block;
	}
}

/**
 * Parses the post content with a PegJS grammar and returns a list of blocks.
 *
 * @param  {String} content The post content
 * @return {Array}          Block list
 */
export function parseWithGrammar( content ) {
	return grammarParse( content ).reduce( ( memo, blockNode ) => {
		const { blockName, rawContent, attrs } = blockNode;
		const block = createBlockWithFallback( blockName, rawContent.trim(), attrs );
		if ( block ) {
			memo.push( block );
		}
		return memo;
	}, [] );
}

export default parseWithGrammar;
