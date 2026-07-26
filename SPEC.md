# The cardano masterpiece specs

onchain collaborative art nft

1024x1024 pixels `image/bmp`

ipfs storage

8 rows of 1024 pixel per leaf (128 leafs, 8192 pixels, 1 byte per pixel)

the 128 leafs are stored as an onchain linked list contract

each ownership nft created is stored in another onchain linked list, to guarantee uniquness.

to edit a pixel, a reference input having an nft corresponding to the ownership of that pixel should be referenced in the edit tx.

